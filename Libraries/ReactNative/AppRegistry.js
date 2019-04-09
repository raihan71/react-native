/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */
'use strict';

const BatchedBridge = require('BatchedBridge');
const BugReporting = require('BugReporting');
const NativeModules = require('NativeModules');
const ReactNative = require('ReactNative');
const SceneTracker = require('SceneTracker');

const infoLog = require('infoLog');
const invariant = require('invariant');
const renderApplication = require('renderApplication');
const createPerformanceLogger = require('createPerformanceLogger');
import type {IPerformanceLogger} from 'createPerformanceLogger';

type Task = (taskData: any) => Promise<void>;
type TaskProvider = () => Task;
type TaskCanceller = () => void;
type TaskCancelProvider = () => TaskCanceller;

export type ComponentProvider = () => React$ComponentType<any>;
export type ComponentProviderInstrumentationHook = (
  component: ComponentProvider,
  scopedPerformanceLogger: IPerformanceLogger,
) => React$ComponentType<any>;
export type AppConfig = {
  appKey: string,
  component?: ComponentProvider,
  run?: Function,
  section?: boolean,
};
export type Runnable = {
  component?: ComponentProvider,
  run: Function,
};
export type Runnables = {
  [appKey: string]: Runnable,
};
export type Registry = {
  sections: Array<string>,
  runnables: Runnables,
};
export type WrapperComponentProvider = any => React$ComponentType<*>;

const runnables: Runnables = {};
let runCount = 1;
const sections: Runnables = {};
const taskProviders: Map<string, TaskProvider> = new Map();
const taskCancelProviders: Map<string, TaskCancelProvider> = new Map();
let componentProviderInstrumentationHook: ComponentProviderInstrumentationHook = (
  component: ComponentProvider,
) => component();

let wrapperComponentProvider: ?WrapperComponentProvider;

/**
 * `AppRegistry` is the JavaScript entry point to running all React Native apps.
 *
 * See http://facebook.github.io/react-native/docs/appregistry.html
 */
const AppRegistry = {
  setWrapperComponentProvider(provider: WrapperComponentProvider) {
    wrapperComponentProvider = provider;
  },

  registerConfig(config: Array<AppConfig>): void {
    config.forEach(appConfig => {
      if (appConfig.run) {
        AppRegistry.registerRunnable(appConfig.appKey, appConfig.run);
      } else {
        invariant(
          appConfig.component != null,
          'AppRegistry.registerConfig(...): Every config is expected to set ' +
            'either `run` or `component`, but `%s` has neither.',
          appConfig.appKey,
        );
        AppRegistry.registerComponent(
          appConfig.appKey,
          appConfig.component,
          appConfig.section,
        );
      }
    });
  },

  /**
   * Registers an app's root component.
   *
   * See http://facebook.github.io/react-native/docs/appregistry.html#registercomponent
   */
  registerComponent(
    appKey: string,
    componentProvider: ComponentProvider,
    section?: boolean,
  ): string {
    let scopedPerformanceLogger = createPerformanceLogger();
    runnables[appKey] = {
      componentProvider,
      run: appParameters => {
        renderApplication(
          componentProviderInstrumentationHook(
            componentProvider,
            scopedPerformanceLogger,
          ),
          appParameters.initialProps,
          appParameters.rootTag,
          wrapperComponentProvider && wrapperComponentProvider(appParameters),
          appParameters.fabric,
          false,
          scopedPerformanceLogger,
        );
      },
    };
    if (section) {
      sections[appKey] = runnables[appKey];
    }
    return appKey;
  },

  registerRunnable(appKey: string, run: Function): string {
    runnables[appKey] = {run};
    return appKey;
  },

  registerSection(appKey: string, component: ComponentProvider): void {
    AppRegistry.registerComponent(appKey, component, true);
  },

  getAppKeys(): Array<string> {
    return Object.keys(runnables);
  },

  getSectionKeys(): Array<string> {
    return Object.keys(sections);
  },

  getSections(): Runnables {
    return {
      ...sections,
    };
  },

  getRunnable(appKey: string): ?Runnable {
    return runnables[appKey];
  },

  getRegistry(): Registry {
    return {
      sections: AppRegistry.getSectionKeys(),
      runnables: {...runnables},
    };
  },

  setComponentProviderInstrumentationHook(
    hook: ComponentProviderInstrumentationHook,
  ) {
    componentProviderInstrumentationHook = hook;
  },

  /**
   * Loads the JavaScript bundle and runs the app.
   *
   * See http://facebook.github.io/react-native/docs/appregistry.html#runapplication
   */
  runApplication(appKey: string, appParameters: any): void {
    const msg =
      'Running application "' +
      appKey +
      '" with appParams: ' +
      JSON.stringify(appParameters) +
      '. ' +
      '__DEV__ === ' +
      String(__DEV__) +
      ', development-level warning are ' +
      (__DEV__ ? 'ON' : 'OFF') +
      ', performance optimizations are ' +
      (__DEV__ ? 'OFF' : 'ON');
    infoLog(msg);
    BugReporting.addSource(
      'AppRegistry.runApplication' + runCount++,
      () => msg,
    );
    invariant(
      runnables[appKey] && runnables[appKey].run,
      'Application ' +
        appKey +
        ' has not been registered.\n\n' +
        "Hint: This error often happens when you're running the packager " +
        '(local dev server) from a wrong folder. For example you have ' +
        'multiple apps and the packager is still running for the app you ' +
        'were working on before.\nIf this is the case, simply kill the old ' +
        'packager instance (e.g. close the packager terminal window) ' +
        'and start the packager in the correct app folder (e.g. cd into app ' +
        "folder and run 'npm start').\n\n" +
        'This error can also happen due to a require() error during ' +
        'initialization or failure to call AppRegistry.registerComponent.\n\n',
    );

    SceneTracker.setActiveScene({name: appKey});
    runnables[appKey].run(appParameters);
  },

  /**
   * Stops an application when a view should be destroyed.
   *
   * See http://facebook.github.io/react-native/docs/appregistry.html#unmountapplicationcomponentatroottag
   */
  unmountApplicationComponentAtRootTag(rootTag: number): void {
    ReactNative.unmountComponentAtNodeAndRemoveContainer(rootTag);
  },

  /**
   * Register a headless task. A headless task is a bit of code that runs without a UI.
   *
   * See http://facebook.github.io/react-native/docs/appregistry.html#registerheadlesstask
   */
  registerHeadlessTask(taskKey: string, taskProvider: TaskProvider): void {
    this.registerCancellableHeadlessTask(taskKey, taskProvider, () => () => {
      /* Cancel is no-op */
    });
  },

  /**
   * Register a cancellable headless task. A headless task is a bit of code that runs without a UI.
   *
   * See http://facebook.github.io/react-native/docs/appregistry.html#registercancellableheadlesstask
   */
  registerCancellableHeadlessTask(
    taskKey: string,
    taskProvider: TaskProvider,
    taskCancelProvider: TaskCancelProvider,
  ): void {
    if (taskProviders.has(taskKey)) {
      console.warn(
        `registerHeadlessTask or registerCancellableHeadlessTask called multiple times for same key '${taskKey}'`,
      );
    }
    taskProviders.set(taskKey, taskProvider);
    taskCancelProviders.set(taskKey, taskCancelProvider);
  },

  /**
   * Only called from native code. Starts a headless task.
   *
   * See http://facebook.github.io/react-native/docs/appregistry.html#startheadlesstask
   */
  startHeadlessTask(taskId: number, taskKey: string, data: any): void {
    const taskProvider = taskProviders.get(taskKey);
    if (!taskProvider) {
      throw new Error(`No task registered for key ${taskKey}`);
    }
    taskProvider()(data)
      .then(() =>
        NativeModules.HeadlessJsTaskSupport.notifyTaskFinished(taskId),
      )
      .catch(reason => {
        console.error(reason);
        NativeModules.HeadlessJsTaskSupport.notifyTaskFinished(taskId);
      });
  },

  /**
   * Only called from native code. Cancels a headless task.
   *
   * See http://facebook.github.io/react-native/docs/appregistry.html#cancelheadlesstask
   */
  cancelHeadlessTask(taskId: number, taskKey: string): void {
    const taskCancelProvider = taskCancelProviders.get(taskKey);
    if (!taskCancelProvider) {
      throw new Error(`No task canceller registered for key '${taskKey}'`);
    }
    taskCancelProvider()();
  },
};

BatchedBridge.registerCallableModule('AppRegistry', AppRegistry);

module.exports = AppRegistry;