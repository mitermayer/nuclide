'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

/**
 * This is a temporary hack to hook into atom://nuclide URIs until
 * https://github.com/atom/atom/pull/11399 is merged into Atom.
 *
 * This uses the urlMain package hook to decode the opened URL and sends it back
 * to an open Nuclide window via an Electron IPC message.
 * This is then intercepted by a Nuclide package and dispatched to subscribers.
 *
 * If no window is currently open, we try to restore the previous Atom state.
 * NOTE: If we decide to just exit here, this permanently destroys the previous
 * window state(s). This is the primary problem with this hack, but luckily
 * it's possible to directly read the previous application state.
 */

/* global localStorage */

import electron from 'electron';
import invariant from 'invariant';
// eslint-disable-next-line nuclide-internal/prefer-nuclide-uri
import path from 'path';
import querystring from 'querystring';
import url from 'url';

const {remote} = electron;
invariant(remote != null, 'for Flow');

const CHANNEL = 'nuclide-url-open';

// https://github.com/atom/atom/blob/master/src/window-load-settings-helpers.coffee
// We can't use this directly since the resourcePath is specified from loadSettings.
let loadSettings;
function getLoadSettings(): Object {
  if (loadSettings === undefined) {
    loadSettings = JSON.parse(decodeURIComponent(document.location.hash.substr(1)));
  }
  return loadSettings;
}

// Contains initialPaths for each previously-running Atom window.
// Atom can handle retrieving the more detailed state by itself.
function getApplicationState(home: string): ?Array<Object> {
  // $FlowIgnore
  const StorageFolder = require(path.join(
    getLoadSettings().resourcePath,
    'src/storage-folder.js',
  ));
  return new StorageFolder(home).load('application.json');
}

// This is the function that Atom normally calls to initialize a new window.
// By calling it, we can simulate starting up a regular Atom window.
function getAtomInitializerScript() {
  return path.join(
    getLoadSettings().resourcePath,
    'src/initialize-application-window.js',
  );
}

// Read the previous window state and create Atom windows as appropriate.
function restoreWindows(blobStore: Object): void {
  invariant(process.env.ATOM_HOME, 'ATOM_HOME not found');
  const windowStates = getApplicationState(process.env.ATOM_HOME) || [];
  const initScript = getAtomInitializerScript();

  // Modify some of the load settings to match a real Atom window.
  document.location.hash = encodeURIComponent(JSON.stringify({
    ...getLoadSettings(),
    // Replace the initialization script so reloading works.
    windowInitializationScript: initScript,
    // Inherit the initialPaths from the first state.
    // We need to set this before initializing Atom to restore the state.
    initialPaths: windowStates[0] != null && windowStates[0].initialPaths || [],
  }));

  // Start up a real Atom instance in the current window.
  // Note that the `atom` global becomes accessible synchronously.
  // $FlowIgnore
  require(initScript)(blobStore);

  for (const windowState of windowStates.slice(1)) {
    const initialPaths = windowState.initialPaths || [];
    atom.open({initialPaths, pathsToOpen: initialPaths});
  }
}

const LOCK_KEY = CHANNEL + '.lock';
const LOCK_TIMEOUT = 10000;

function acquireLock(): boolean {
  // localStorage.set/getItem is not truly atomic, so this is not actually sound.
  // However, it should be fast enough to cover the use case of human clicks.
  const lockTime = localStorage.getItem(LOCK_KEY);
  if (lockTime != null && Date.now() - parseInt(lockTime, 10) < LOCK_TIMEOUT) {
    return false;
  }
  localStorage.setItem(LOCK_KEY, String(Date.now()));
  return true;
}

function releaseLock(): void {
  localStorage.removeItem(LOCK_KEY);
}

// This function gets called by the Atom package-level URL handler.
// Normally this is expected to set up the Atom application window.
async function initialize(blobStore: Object): Promise<mixed> {
  const currentWindow = remote.getCurrentWindow();
  try {
    const {urlToOpen} = getLoadSettings();
    const {host, pathname, query} = url.parse(urlToOpen);
    invariant(
      host === 'nuclide' && pathname != null && pathname !== '',
      `Invalid URL ${urlToOpen}`,
    );

    const message = pathname.substr(1);
    const params = querystring.parse(query || '');

    // Prefer the focused window, but any existing window.
    // The parent window is used for testing only.
    const existingWindow = currentWindow.getParentWindow() ||
      remote.BrowserWindow.getFocusedWindow() ||
      remote.BrowserWindow.getAllWindows().filter(x => x.id !== currentWindow.id)[0];
    if (existingWindow == null) {
      // Prevent multiple windows from being opened when URIs are opened too quickly.
      invariant(acquireLock(), 'Another URI is already being opened.');

      // Restore the user's previous windows.
      // The real Atom initialization script will be run in the current window.
      restoreWindows(blobStore);

      // Wait for Nuclide to activate (so the event below gets handled).
      await new Promise(resolve => {
        atom.packages.onDidActivateInitialPackages(resolve);
      });

      currentWindow.webContents.send(CHANNEL, {message, params});
      releaseLock();
    } else {
      existingWindow.webContents.send(CHANNEL, {message, params});
      // Atom has various handlers that block window closing.
      currentWindow.destroy();
    }
  } catch (err) {
    remote.dialog.showErrorBox('Could not open URL', err.stack);
    releaseLock();
    currentWindow.destroy();
  }
}

module.exports = initialize;

// Exported for testing.
module.exports.__test__ = {
  getLoadSettings,
  getApplicationState,
  getAtomInitializerScript,
  acquireLock,
  releaseLock,
};
