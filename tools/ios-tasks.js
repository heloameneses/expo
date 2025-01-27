'use strict';

const fs = require('fs-extra');
const glob = require('glob-promise');
const path = require('path');
const shell = require('shelljs');
const { Modules } = require('@expo/xdl');
const inquirer = require('inquirer');

const { runTransformPipelineIOSAsync } = require('./ios-versioning');

const UNVERSIONED_PLACEHOLDER = '__UNVERSIONED__';
const RELATIVE_RN_PATH = './react-native-lab/react-native';

const RELATIVE_UNIVERSAL_MODULES_PATH = './packages';
const EXTERNAL_REACT_ABI_DEPENDENCIES = [
  'Amplitude-iOS',
  'Analytics',
  'AppAuth',
  'FBAudienceNetwork',
  'FBSDKCoreKit',
  'FBSDKLoginKit',
  'GoogleSignIn',
  'GoogleMaps',
  'Google-Maps-iOS-Utils',
  'lottie-ios',
  'JKBigInteger2',
  'Branch',
  'Google-Mobile-Ads-SDK',
];

/**
 *  Transform and rename the given react native source code files.
 *  @param filenames list of files to transform
 *  @param versionPrefix A version-specific prefix to apply to all symbols in the code, e.g.
 *    RCTSomeClass becomes {versionPrefix}RCTSomeClass
 *  @param versionedPodNames mapping from unversioned cocoapods names to versioned cocoapods names,
 *    e.g. React -> ReactABI99_0_0
 */
async function namespaceReactNativeFilesAsync(
  filenames,
  versionPrefix,
  versionedPodNames
) {
  const reactPodName = versionedPodNames.React;
  const transformRules = _getReactNativeTransformRules(versionPrefix, reactPodName);

  let transformPatternsCache = {};
  await Promise.all(
    filenames.map(async (filename) => {
      if (_isDirectory(filename)) {
        return;
      }
      // protect contents of EX_UNVERSIONED macro
      let unversionedCaptures = [];
      await _transformFileContentsAsync(filename, fileString => {
        let pattern = /EX_UNVERSIONED\((.*)\)/g;
        let match = pattern.exec(fileString);
        while (match != null) {
          unversionedCaptures.push(match[1]);
          match = pattern.exec(fileString);
        }
        if (unversionedCaptures.length) {
          return fileString.replace(pattern, UNVERSIONED_PLACEHOLDER);
        }
        return null;
      });

      // rename file
      let dirname = path.dirname(filename);
      let basename = path.basename(filename);
      let target;
      if (basename.startsWith('EX') || basename.includes('EXReact') || basename.includes('UMReact') || !basename.includes('React')) {
        target = `${versionPrefix}${basename}`;
      } else {
        target = basename.replace(/React/g, reactPodName);
      }

      let transformPatterns;
      if (transformPatternsCache[dirname]) {
        transformPatterns = transformPatternsCache[dirname];
      } else {
        // filter transformRules to patterns which apply to this dirname
        transformPatterns = _getTransformPatternsForDirname(transformRules, dirname);
        transformPatternsCache[dirname] = transformPatterns;
      }

      const targetPath = `${dirname}/${target}`;

      // perform sed find/replace
      let cmd = transformPatterns
        .map(pattern => `sed -i -- '${pattern}' ${filename}`)
        .concat(`mv ${filename} ${targetPath}`)
        .join(' && ');
      shell.exec(cmd);

      // perform transforms that sed can't express
      await _transformFileContentsAsync(targetPath, async (fileString) => {
        // rename misc imports, e.g. Layout.h
        fileString = fileString.replace(
          /(")((?:(?!ART)(?!YG)(?!RN)(?!AIR)(?![^J]SM)(?!RCT)(?!React)(?!REA)(?!FBSDK)(?!EX)(?!UM).)+)\.h(\W)/g,
          `$1${versionPrefix}$2.h$3`
        );

        // rename cpp imports
        getCppLibrariesToVersion().forEach(libraryName => {
          let versionedLibraryName = getVersionedCppLibraryName(
            libraryName,
            versionPrefix
          );
          if (libraryName === 'jsiexecutor') {
            fileString = fileString.replace(
              new RegExp('("|<)jsiReact(ABI\\d+_\\d+_\\d+)\/([^.]+)\\.h.', 'g'),
              `<jsireact\/${versionPrefix}$3.h>`
            );
          } else {
            fileString = fileString.replace(
              new RegExp(`<(${versionedLibraryName}|${libraryName})\/([^.]+)\\.h>`, 'g'),
              (match, p1, p2) => {
                const filename = p2.includes(versionPrefix) ? p2 : `${versionPrefix}${p2}`;
                return `<${versionedLibraryName}\/${filename}.h>`;
              }
            );
          }
        });

        // restore EX_UNVERSIONED contents
        if (unversionedCaptures) {
          let index = 0;
          do {
            fileString = fileString.replace(
              UNVERSIONED_PLACEHOLDER,
              unversionedCaptures[index]
            );
            index++;
          } while (fileString.indexOf(UNVERSIONED_PLACEHOLDER) !== -1);
        }

        return await runTransformPipelineIOSAsync({
          input: fileString,
          targetPath,
          versionPrefix,
        });
      });
      return; // process `filename`
    })
  );
  return;
}

/**
 *  Transform and rename all code files we care about under `rnPath`
 */
async function transformReactNativeAsync(
  rnPath,
  versionName,
  versionedPodNames
) {
  let filenameQueries = [
    `${rnPath}/**/*.[hmSc]`,
    `${rnPath}/**/*.mm`,
    `${rnPath}/**/*.cpp`,
  ];
  let filenames = [];
  await Promise.all(
    filenameQueries.map(async query => {
      let queryFilenames = await glob(query);
      if (queryFilenames) {
        filenames = filenames.concat(queryFilenames);
      }
    })
  );

  return namespaceReactNativeFilesAsync(
    filenames,
    versionName,
    versionedPodNames
  );
}

/**
 * For all files matching the given glob query, namespace and rename them
 * with the given version number. This utility is mainly useful for backporting
 * small changes into an existing SDK. To create a new SDK version, use `addVersionAsync`
 * instead.
 * @param globQuery a string to pass to glob which matches some file paths
 * @param versionNumber Exponent SDK version, e.g. 42.0.0
 */
exports.versionReactNativeIOSFilesAsync = async function versionReactNativeIOSFilesAsync(
  globQuery,
  versionNumber
) {
  let filenames = await glob(globQuery);
  if (!filenames || !filenames.length) {
    throw new Error(`No files matched the given pattern: ${globQuery}`);
  }
  let { versionName, versionedPodNames } = getConfigsFromArguments(
    versionNumber,
    '.'
  );
  console.log(
    `Versioning ${filenames.length} files with SDK version ${versionNumber}...`
  );
  return namespaceReactNativeFilesAsync(
    filenames,
    versionName,
    versionedPodNames
  );
};

/**
 *  @param newVersionPath path to the pod for the new RN version
 *  @param versionedPodNames mapping from lib names to versioned lib names
 */
async function generatePodspecsAsync(
  newVersionPath,
  versionedPodNames,
  versionName,
  versionNumber
) {
  const { React, yoga, ExpoKit, ...universalModules } = versionedPodNames;
  await generateReactPodspecAsync(
    newVersionPath,
    versionedPodNames,
    versionName,
    universalModules,
    versionNumber
  );
  await generateExpoKitPodspecAsync(
    newVersionPath,
    versionedPodNames,
    universalModules,
    versionNumber
  );
  await generateYogaPodspecAsync(
    path.join(newVersionPath, 'ReactCommon', `${versionName}yoga`),
    yoga,
    versionName
  );
  const versionedUniversalModuleNames = Object.keys(universalModules);

  versionedUniversalModuleNames.map(originalPodName => {
    const prefixedPodName = `${versionName}${originalPodName}`;
    const originalPodSpecPath = path.join(
      newVersionPath,
      originalPodName,
      `${originalPodName}.podspec`
    );
    const prefixedPodSpecPath = path.join(
      newVersionPath,
      originalPodName,
      `${prefixedPodName}.podspec`
    );

    shell.exec(`mv ${originalPodSpecPath} ${prefixedPodSpecPath}`);

    // Replaces versioned modules in the podspec eg. 'EXCore' => 'ABI28_0_0EXCore'
    // `E` flag is required for extended syntax which allows to use `(a|b)`
    const depsToReplace = versionedUniversalModuleNames.join('|');
    shell.exec(
      `sed -Ei -- "s/'(${depsToReplace})('|\\/)/'${versionName}\\1\\2/g" ${prefixedPodSpecPath}`
    );

    shell.exec(`sed -i -- 's/React/${React}/g' ${prefixedPodSpecPath}`);
    shell.exec(
      `sed -i -- 's/${versionName}UM${React}/${versionName}UMReact/g' ${prefixedPodSpecPath}`
    );
    shell.exec(`sed -i -- "s/'..', 'package.json'/'package.json'/g" ${prefixedPodSpecPath}`);
  });
  return;
}

/**
 * Transforms ExpoKit.podspec, versioning Expo namespace, React pod name, replacing original ExpoKit podspecs
 * with Expo and ExpoOptional.
 * @param specfilePath location of ExpoKit.podspec to modify, e.g. /versioned-react-native/someversion/
 * @param versionedReactPodName name of the new pod (and podfile)
 * @param universalModulesPodNames versioned names of universal modules
 * @param versionNumber "XX.X.X"
 */
async function generateExpoKitPodspecAsync(
  specfilePath,
  versionedPodNames,
  universalModulesPodNames,
  versionNumber
) {
  const versionedReactPodName = versionedPodNames.React;
  const versionedExpoKitPodName = versionedPodNames.ExpoKit;
  let specFilename = `${specfilePath}/ExpoKit.podspec`;

  // rename spec to newPodName
  let sedPattern = `s/\\(s\\.name[[:space:]]*=[[:space:]]\\)"ExpoKit"/\\1"${versionedExpoKitPodName}"/g`;
  shell.exec(`sed -i -- '${sedPattern}' ${specFilename}`);

  // further processing that sed can't do very well
  await _transformFileContentsAsync(specFilename, fileString => {
    // `universalModulesPodNames` contains only versioned unimodules,
    // so we fall back to the original name if the module is not there
    const universalModulesDependencies = Modules.getAllNativeForExpoClientOnPlatform('ios', versionNumber).map(
      ({ podName }) => `ss.dependency         "${universalModulesPodNames[podName] || podName}"`
    ).join(`
    `);
    const externalDependencies = EXTERNAL_REACT_ABI_DEPENDENCIES.map(
      podName => `ss.dependency         "${podName}"`
    ).join(`
    `);
    let subspec =
 `s.subspec "Expo" do |ss|
    ss.source_files     = "Expo/Core/**/*.{h,m,mm}"

    ss.dependency         "${versionedReactPodName}/Core"
    ${universalModulesDependencies}
    ${externalDependencies}
  end

  s.subspec "ExpoOptional" do |ss|
    ss.dependency         "${versionedExpoKitPodName}/Expo"
    ss.source_files     = "Expo/Optional/**/*.{h,m,mm}"
  end`;
    fileString = fileString.replace(
      /(s\.subspec ".+?"[\S\s]+?(?=end\b)end\b[\s]+)+/g,
      `${subspec}\n`
    );

    return fileString;
  });

  // move podspec to ${versionedExpoKitPodName}.podspec
  shell.exec(
    `mv ${specFilename} ${specfilePath}/${versionedExpoKitPodName}.podspec`
  );

  return;
}

/**
*  @param specfilePath location of React.podspec to modify, e.g. /versioned-react-native/someversion/
*  @param versionedReactPodName name of the new pod (and podfile)
*/
async function generateReactPodspecAsync(
  specfilePath,
  versionedPodNames,
  versionName,
  universalModulesPodNames,
  versionNumber
) {
  const versionedReactPodName = versionedPodNames.React;
  const versionedYogaPodName = versionedPodNames.yoga;
  let specFilename = `${specfilePath}/React.podspec`;

  // rename spec to newPodName
  let sedPattern = `s/\\(s\\.name[[:space:]]*=[[:space:]]\\)"React"/\\1"${versionedReactPodName}"/g`;
  shell.exec(`sed -i -- '${sedPattern}' ${specFilename}`);

  // rename header_dir
  shell.exec(
    `sed -i -- 's/^\\(.*header_dir.*\\)React\\(.*\\)$/\\1${versionedReactPodName}\\2/' ${specFilename}`
  );

  // point source at .
  let newPodSource = `{ :path => "." }`;
  sedPattern = `s/\\(s\\.source[[:space:]]*=[[:space:]]\\).*/\\1${newPodSource}/g`;
  shell.exec(`sed -i -- '${sedPattern}' ${specFilename}`);

  // further processing that sed can't do very well
  await _transformFileContentsAsync(specFilename, fileString => {
    // replace React/* dependency with ${versionedReactPodName}/*
    fileString = fileString.replace(
      /(ss\.dependency\s+)"React\/(\S+)"/g,
      `$1"${versionedReactPodName}/$2"`
    );

    fileString = fileString.replace('/RCTTV', `/${versionName}RCTTV`);

    // namespace cpp libraries
    let cppLibraries = getCppLibrariesToVersion();
    cppLibraries.forEach(libraryName => {
      fileString = fileString.replace(
        new RegExp(`([^A-Za-z0-9_])${libraryName}([^A-Za-z0-9_])`, 'g'),
        `$1${getVersionedCppLibraryName(libraryName, versionName)}$2`
      );
    });

    // fix wrong Yoga pod name
    fileString = fileString.replace(
      /^(.*dependency.*["']).*yoga.*?(["'].*)$/m,
      `$1${versionedYogaPodName}$2`
    );

    return fileString;
  });

  // move podspec to ${versionedReactPodName}.podspec
  shell.exec(
    `mv ${specFilename} ${specfilePath}/${versionedReactPodName}.podspec`
  );

  return;
}

async function generateYogaPodspecAsync(
  specfilePath,
  versionedYogaPodName,
  versionName
) {
  let specFilename = `${specfilePath}/yoga.podspec`;
  const versionedLibraryName = getVersionedCppLibraryName('yoga', versionName);

  await _transformFileContentsAsync(specFilename, fileString => {
    // namespace file references
    fileString = fileString.replace(/yoga/g, versionedLibraryName);

    // rename spec
    fileString = fileString.replace(/(spec.name \= )\S+\n/g, `$1'${versionedYogaPodName}'\n`);

    // remove source conditional
    fileString = fileString.replace(/source \= \{[.\S\s]+?(?=Pod)/g, '');

    // point source at .
    fileString = fileString.replace(
      /(spec.source \= )\S+\n/g,
      `$1{ :path => "." }\n`
    );

    // un-namespace inner directory for source_files
    fileString = fileString.replace(
      /(source_files \= \')\S+?(?=\/)/g,
      `$1yoga`
    );

    fileString = fileString.replace('spec.module_name = ', 'spec.module_name = spec.header_dir = ');
    return fileString;
  });

  // move podspec to ${versionedReactPodName}.podspec
  shell.exec(
    `mv ${specFilename} ${specfilePath}/${versionedYogaPodName}.podspec`
  );

  return;
}

function getCFlagsToPrefixGlobals(prefix, globals) {
  return globals.map(val => `-D${val}=${prefix}${val}`);
}

/**
*  @param templatesPath location to write template files, e.g. $UNIVERSE/exponent/template-files/ios
*  @param versionedPodNames mapping from pod names to versioned pod names, e.g. React -> ReactABI99_0_0
*  @param versionedReactPodPath path of the new react pod
*/
async function generatePodfileDepsAsync(
  versionName,
  templatesPath,
  versionedPodNames,
  versionedReactPodPath,
  versionNumber
) {
  if (!versionedPodNames.React) {
    throw new Error(
      'Tried to add generate pod dependencies, but missing a name for the versioned library.'
    );
  }
  let yogaPodDependency = '';
  if (versionedPodNames.yoga) {
    yogaPodDependency = `pod '${versionedPodNames.yoga}', :inhibit_warnings => true, :path => '${versionedReactPodPath}/ReactCommon/${versionName}yoga'`;
  }
  const versionableUniversalModulesPods = Modules.getVersionableModulesForPlatform('ios', versionNumber)
    .map(
      ({ podName }) =>
        `pod '${versionedPodNames[podName]}', :inhibit_warnings => true, :path => '${versionedReactPodPath}/${podName}'`
    )
    .join('\n    ');

  // Add a dependency on newPodName
  const expoDepsTemplateParam = '${REACT_NATIVE_EXPO_SUBSPECS}';
  let dep = `
    # Generated dependency: ${versionedPodNames.React}
    pod '${versionedPodNames.React}', :inhibit_warnings => true, :path => '${versionedReactPodPath}', :subspecs => [
      'Core',
      'ART',
      'DevSupport',
      'RCTActionSheet',
      'RCTAnimation',
      'RCTCameraRoll',
      'RCTGeolocation',
      'RCTImage',
      'RCTNetwork',
      'RCTText',
      'RCTVibration',
      'RCTWebSocket',
      'CxxBridge'
    ]
    pod '${versionedPodNames.ExpoKit}', :inhibit_warnings => true, :path => '${versionedReactPodPath}', :subspecs => [
      ${expoDepsTemplateParam}
    ]
    ${yogaPodDependency}
    ${versionableUniversalModulesPods}
    # End generated dependency`;
  await fs.writeFile(
    path.join(
      templatesPath,
      'versioned-react-native',
      'dependencies',
      `${versionedPodNames.React}.rb`
    ),
    `${dep}\n`
  );

  // Add postinstall.
  // In particular, resolve conflicting globals from React by redefining them.
  let globals = {
    React: [
      // RCTNavigator
      'kNeverRequested',
      'kNeverProgressed',
      // react-native-maps
      'kSMCalloutViewRepositionDelayForUIScrollView',
      'regionAsJSON',
      'unionRect',
      // jschelpers
      'JSNoBytecodeFileFormatVersion',
      'JSSamplingProfilerEnabled',
      // RCTInspectorPackagerConnection
      'RECONNECT_DELAY_MS',
      // RCTSpringAnimation
      'MAX_DELTA_TIME',
    ],
    yoga: [
      'gCurrentGenerationCount',
      'gPrintSkips',
      'gPrintChanges',
      'layoutNodeInternal',
      'gDepth',
      'gPrintTree',
      'isUndefined',
      'gNodeInstanceCount',
    ],
  };
  let configValues = getCFlagsToPrefixGlobals(
    versionedPodNames.React,
    globals.React.concat(globals.yoga)
  );
  const indent = '  '.repeat(6);
  let config = `
      # Generated postinstall: ${versionedPodNames.React}
      if pod_name == '${versionedPodNames.React}' || pod_name == '${versionedPodNames.ExpoKit}'
      target_installation_result.native_target.build_configurations.each do |config|
          config.build_settings['OTHER_CFLAGS'] = %w[
            ${configValues.join(`\n${indent}`)}
          ]
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << '${versionName}RCT_DEV=1'
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << '${versionName}RCT_ENABLE_INSPECTOR=0'
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << '${versionName}ENABLE_PACKAGER_CONNECTION=0'
          # Enable Google Maps support
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << '${versionName}HAVE_GOOGLE_MAPS=1'
          config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << '${versionName}HAVE_GOOGLE_MAPS_UTILS=1'
        end
      end
      # End generated postinstall`;
  await fs.writeFile(
    path.join(
      templatesPath,
      'versioned-react-native',
      'postinstalls',
      `${versionedPodNames.React}.rb`
    ),
    `${config}\n`
  );
  return;
}

async function removePodfileDepsAsync(templatesPath, versionedPodNames) {
  // we only generate deps/postinstalls for React right now
  if (versionedPodNames['React']) {
    let versionedPodName = versionedPodNames['React'];
    const depFilename = path.join(
      templatesPath,
      'versioned-react-native',
      'dependencies',
      `${versionedPodName}.rb`
    );
    const postinstallFilename = path.join(
      templatesPath,
      'versioned-react-native',
      'postinstalls',
      `${versionedPodName}.rb`
    );
    let filesToRemove = [depFilename, postinstallFilename];
    filesToRemove.forEach(fileToRemove => {
      try {
        fs.accessSync(fileToRemove, fs.F_OK);
        shell.exec(`rm ${fileToRemove}`);
      } catch (e) {}
    });
  }
  return;
}

/**
* @param transformConfig function that takes a config dict and returns a new config dict.
*/
async function modifyVersionConfigAsync(configPath, transformConfig) {
  let jsConfigFilename = `${configPath}/sdkVersions.json`;
  await _transformFileContentsAsync(jsConfigFilename, jsConfigContents => {
    let jsConfig;

    // read the existing json config and add the new version to the sdkVersions array
    try {
      jsConfig = JSON.parse(jsConfigContents);
    } catch (e) {
      console.log(
        'Error parsing existing sdkVersions.json file, writing a new one...',
        e
      );
      console.log('The erroneous file contents was:', jsConfigContents);
      jsConfig = {
        sdkVersions: [],
      };
    }
    // apply changes
    jsConfig = transformConfig(jsConfig);
    return JSON.stringify(jsConfig);
  });

  // convert json config to plist for iOS
  shell.exec(
    `plutil -convert xml1 ${jsConfigFilename} -o ${configPath}/EXSDKVersions.plist`
  );
  return;
}

function validateAddVersionDirectories(rootPath, newVersionPath) {
  // Make sure the paths we want to read are available
  let relativePathsToCheck = [
    RELATIVE_RN_PATH,
    'ios/versioned-react-native',
    'ios/Exponent',
    'ios/Exponent/Versioned',
  ];
  let isValid = true;
  relativePathsToCheck.forEach(path => {
    try {
      fs.accessSync(`${rootPath}/${path}`, fs.F_OK);
    } catch (e) {
      console.log(
        `${rootPath}/${path} does not exist or is otherwise inaccessible`
      );
      isValid = false;
    }
  });
  // Also, make sure the version we're about to write doesn't already exist
  try {
    // we want this to fail
    fs.accessSync(newVersionPath, fs.F_OK);
    console.log(`${newVersionPath} already exists, will not overwrite`);
    isValid = false;
  } catch (e) {}

  return isValid;
}

function validateRemoveVersionDirectories(rootPath, newVersionPath) {
  let pathsToCheck = [
    `${rootPath}/ios/versioned-react-native`,
    `${rootPath}/template-files/ios/Podfile`,
    `${rootPath}/ios/Exponent`,
    newVersionPath,
  ];
  let isValid = true;
  pathsToCheck.forEach(path => {
    try {
      fs.accessSync(path, fs.F_OK);
    } catch (e) {
      console.log(`${path} does not exist or is otherwise inaccessible`);
      isValid = false;
    }
  });
  return isValid;
}

function getConfigsFromArguments(versionNumber, rootPath) {
  let versionComponents = versionNumber.split('.');
  versionComponents = versionComponents.map(number => parseInt(number, 10));
  let versionName = 'ABI' + versionNumber.replace(/\./g, '_');
  const templateVersionedRnPath = '${VERSIONED_REACT_NATIVE_PATH}'; // resolved by IosPodsTools at render-time
  let newVersionRelativePath = path.join(templateVersionedRnPath, versionName);
  let rootPathComponents = rootPath.split('/');
  let versionPathComponents = path.join('ios', 'versioned-react-native', versionName).split('/');
  let newVersionPath = rootPathComponents
    .concat(versionPathComponents)
    .join('/');

  let versionedPodNames = {
    React: `React${versionName}`,
    yoga: `yoga${versionName}`,
    ExpoKit: `${versionName}ExpoKit`,
  };
  Modules.getVersionableModulesForPlatform('ios', versionNumber)
    .forEach(({ podName }) => {
      versionedPodNames[podName] = `${versionName}${podName}`;
    });

  return {
    versionName,
    newVersionRelativePath,
    newVersionPath,
    versionedPodNames,
    versionComponents,
  };
}

function getCppLibrariesToVersion() {
  return ['cxxreact', 'jsi', 'jsiexecutor', 'jsinspector', 'yoga', 'fabric'];
}

function getVersionedCppLibraryName(unversionedLibraryName, newVersionName) {
  // TODO: generalize
  if (unversionedLibraryName === 'cxxreact') {
    return `cxxReact${newVersionName}`;
  }
  return `${newVersionName}${unversionedLibraryName}`;
}

function getExcludedOptionalDirectories() {
  // we don't want Payments in Expo Client versions for now
  return ['Payments'];
}

exports.addVersionAsync = async function addVersionAsync(
  versionNumber,
  rootPath
) {
  let {
    versionName,
    versionComponents,
    newVersionRelativePath,
    newVersionPath,
    versionedPodNames,
  } = getConfigsFromArguments(versionNumber, rootPath);

  console.log(
    `Adding ABI version ${versionNumber} at ${newVersionPath} with Pod name ${versionedPodNames.React}`
  );

  // Validate the directories we need before doing anything
  console.log(`Validating root directory '${rootPath}' ...`);
  let isFilesystemReady = validateAddVersionDirectories(
    rootPath,
    newVersionPath
  );
  if (!isFilesystemReady) {
    throw new Error(
      'Aborting: At least one directory we need is not available'
    );
  }

  if (!versionedPodNames.React) {
    throw new Error('Missing name for versioned pod dependency.');
  }

  // Clone react native latest version
  console.log(`Copying files from ${rootPath}/${RELATIVE_RN_PATH}...`);
  shell.exec(
    [
      `mkdir -p ${newVersionPath}`,
      `cp -R ${rootPath}/${RELATIVE_RN_PATH}/React ${newVersionPath}/React`,
      `cp -R ${rootPath}/${RELATIVE_RN_PATH}/Libraries ${newVersionPath}/Libraries`,
      `cp ${rootPath}/${RELATIVE_RN_PATH}/React.podspec ${newVersionPath}/.`,
      `cp ${rootPath}/${RELATIVE_RN_PATH}/package.json ${newVersionPath}/.`,
      `find ${newVersionPath} -name '*.js' -type f -delete`,
    ].join(' && ')
  );

  // Copy versioned exponent modules into the clone
  console.log(`Copying versioned native modules into the new Pod...`);
  shell.exec(
    `cp -R ${rootPath}/ios/Exponent/Versioned ${newVersionPath}/Expo`
  );
  shell.exec(`cp ${rootPath}/ExpoKit.podspec ${newVersionPath}/.`);

  // some files in the Optional spec should be omitted from versioned code
  const excludedOptionalDirectories = getExcludedOptionalDirectories();
  excludedOptionalDirectories.forEach(dir => {
    const optionalPath = path.join(newVersionPath, 'Expo', 'Optional', dir);
    try {
      fs.accessSync(optionalPath, fs.F_OK);
      shell.exec(`rm -rf ${optionalPath}`);
    } catch (e) {
      console.warn(`Expected ${optionalPath} to be accessible for removal, but it wasn't`);
    }
  });

  // Copy universal modules into the clone
  console.log(`Copying universal modules into the new Pods...`);
  shell.exec(
    Modules
      .getVersionableModulesForPlatform('ios', versionNumber)
      .map(({ libName, podName }) =>
        [
          `cp -R ${rootPath}/${RELATIVE_UNIVERSAL_MODULES_PATH}/${libName}/ios/ ${newVersionPath}/${podName}`,
          `mv ${newVersionPath}/${podName}/${podName} ${newVersionPath}/${podName}/${versionedPodNames[podName]}`,
          `cp -R ${rootPath}/${RELATIVE_UNIVERSAL_MODULES_PATH}/${libName}/package.json ${newVersionPath}/${podName}`,
        ].join(' && ')
      )
      .join(' && ')
  );

  console.log(
    `Copying cpp libraries from ${rootPath}/${RELATIVE_RN_PATH}/ReactCommon...`
  );
  let cppLibraries = getCppLibrariesToVersion();
  shell.exec(`mkdir -p ${newVersionPath}/ReactCommon`);
  cppLibraries.forEach(library => {
    let namespacedLibrary = getVersionedCppLibraryName(library, versionName);
    shell.exec(
      `cp -R ${rootPath}/${RELATIVE_RN_PATH}/ReactCommon/${library} ${newVersionPath}/ReactCommon/${namespacedLibrary}`
    );
  });

  // Generate new Podspec from the existing React.podspec
  // TODO: condition on major version for now
  console.log('Generating Podspecs for new version...');
  await generatePodspecsAsync(newVersionPath, versionedPodNames, versionName, versionNumber);

  // Namespace the new React clone
  console.log('Namespacing/transforming files...');
  await transformReactNativeAsync(
    newVersionPath,
    versionName,
    versionedPodNames
  );

  // Add the new version as a dependency in the main Exponent Podfile
  console.log('Adding dependency to root Podfile...');
  await generatePodfileDepsAsync(
    versionName,
    `${rootPath}/template-files/ios`,
    versionedPodNames,
    newVersionRelativePath,
    versionNumber
  );

  // Add the new version to the iOS config list of available versions
  console.log('Registering new version under sdkVersions config...');
  const addVersionToConfig = (config, versionNumber) => {
    config.sdkVersions.push(versionNumber);
    return config;
  };
  await modifyVersionConfigAsync(
    path.join(rootPath, 'ios', 'Exponent', 'Supporting'),
    config => addVersionToConfig(config, versionNumber)
  );
  await modifyVersionConfigAsync(
    path.join(rootPath, 'exponent-view-template', 'ios', 'exponent-view-template', 'Supporting'),
    config => addVersionToConfig(config, versionNumber)
  );

  const removeExtraMinusMinusFilesCommand = `find ${newVersionPath} -name '*--' | xargs rm`;
  console.log(`Removing any \`filename--\` files from the new pod (running ${removeExtraMinusMinusFilesCommand})`);
  try {
    shell.exec(removeExtraMinusMinusFilesCommand);
  } catch (error) {
    console.warn("The script wasn't able to remove any possible `filename--` files created by sed. Please ensure there are no such files manually.")
  }

  console.log('Finished creating new version.');
  await regeneratePodsAsync();

  return;
};

async function regeneratePodsAsync() {
  const { result } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'result',
      message: 'Do you want to regenerate Podfile and install pods?',
      default: true,
    },
  ]);

  if (result) {
    shell.exec('et ios-generate-dynamic-macros');
    shell.exec('cd ../ios && pod install && cd -');
    console.log('Regenerated Podfile and installed new pods. You can now try to build the project in Xcode.');
  } else {
    console.log('Skipped pods regeneration. You might want to run `et ios-generate-dynamic-macros`, then `pod install` in `ios` to configure Xcode project.');
  }
}

exports.removeVersionAsync = async function removeVersionAsync(
  versionNumber,
  rootPath
) {
  let { newVersionPath, versionedPodNames } = getConfigsFromArguments(
    versionNumber,
    rootPath
  );
  console.log(
    `Removing ABI version ${versionNumber} from ${newVersionPath} with Pod name ${versionedPodNames.React}`
  );

  // Validate the directories we need before doing anything
  console.log(`Validating root directory '${rootPath}' ...`);
  let isFilesystemReady = validateRemoveVersionDirectories(
    rootPath,
    newVersionPath
  );
  if (!isFilesystemReady) {
    console.log('Aborting: At least one directory we expect is not available');
    return;
  }

  // remove directory
  console.log(`Removing versioned files under ${newVersionPath}...`);
  shell.exec(`rm -rf ${newVersionPath}`);

  // remove dep from main podfile
  console.log(
    `Removing ${versionedPodNames.React} dependency from root Podfile...`
  );
  await removePodfileDepsAsync(
    `${rootPath}/template-files/ios`,
    versionedPodNames
  );

  // remove from sdkVersions.json
  console.log('Unregistering version from sdkVersions config...');
  const removeVersionFromConfig = (config, versionNumber) => {
    let index = config.sdkVersions.indexOf(versionNumber);
    if (index > -1) {
      // modify in place
      config.sdkVersions.splice(index, 1);
    }
    return config;
  };
  await modifyVersionConfigAsync(
    path.join(rootPath, 'ios', 'Exponent', 'Supporting'),
    config => removeVersionFromConfig(config, versionNumber)
  );
  await modifyVersionConfigAsync(
    path.join(rootPath, 'exponent-view-template', 'ios', 'exponent-view-template', 'Supporting'),
    config => removeVersionFromConfig(config, versionNumber)
  );

  return;
};

/**
 *  @return an array of objects representing react native transform rules.
 *    objects must contain 'pattern' and may optionally contain 'paths' to limit
 *    the transform to certain file paths.
 *
 *  the rules are applied in order!
 */
function _getReactNativeTransformRules(versionPrefix, reactPodName) {
  return [
    {
      // Change obj-c symbol prefix
      pattern: `s/RCT/${versionPrefix}RCT/g`,
    },
    {
      pattern: `s/^EX/${versionPrefix}EX/g`,
      // paths: 'EX',
    },
    {
      pattern: `s/^UM/${versionPrefix}UM/g`,
      // paths: 'EX',
    },
    {
      pattern: `s/\\([^\\<\\/]\\)YG/\\1${versionPrefix}YG/g`,
    },
    {
      pattern: `s/<YG/<${versionPrefix}YG/g`,
    },
    {
      pattern: `s/^YG/${versionPrefix}YG/g`,
    },
    {
      pattern: `s/yoga/${versionPrefix}yoga/g`,
    },
    {
      paths: 'Components',
      pattern: `s/\\([^+]\\)AIR/\\1${versionPrefix}AIR/g`,
    },
    {
      pattern: `s/\\([^A-Za-z0-9_]\\)EX/\\1${versionPrefix}EX/g`,
    },
    {
      pattern: `s/\\([^A-Za-z0-9_]\\)UM/\\1${versionPrefix}UM/g`,
    },
    {
      pattern: `s/\\([^A-Za-z0-9_+]\\)ART/\\1${versionPrefix}ART/g`,
    },
    {
      pattern: `s/ENABLE_PACKAGER_CONNECTION/${versionPrefix}ENABLE_PACKAGER_CONNECTION/g`,
    },
    {
      paths: 'Components',
      pattern: `s/\\([^A-Za-z0-9_+]\\)SM/\\1${versionPrefix}SM/g`,
    },
    {
      paths: 'Core/Api',
      pattern: `s/\\([^A-Za-z0-9_+]\\)RN/\\1${versionPrefix}RN/g`,
    },
    {
      paths: 'Core/Api',
      pattern: `s/^RN/${versionPrefix}RN/g`,
    },
    {
      paths: 'Core/Api',
      pattern: `s/HAVE_GOOGLE_MAPS/${versionPrefix}HAVE_GOOGLE_MAPS/g`,
    },
    {
      paths: 'Core/Api',
      pattern: `s/#import "Branch/#import "${versionPrefix}Branch/g`,
    },
    {
      paths: 'Core/Api',
      pattern: `s/#import "NSObject+RNBranch/#import "${versionPrefix}NSObject+RNBranch/g`,
    },
    {
      // React will be prefixed in a moment
      pattern: `s/#import <${versionPrefix}RCTAnimation/#import <React/g`,
    },
    {
      paths: 'Core/Api/Reanimated',
      pattern: `s/\\([^A-Za-z0-9_+]\\)REA/\\1${versionPrefix}REA/g`,
    },
    {
      // Change React -> new pod name
      // e.g. threads and queues namespaced to com.facebook.react,
      // file paths beginning with the lib name,
      // the cpp facebook::react namespace,
      // iOS categories ending in +React
      pattern: `s/[Rr]eact/${reactPodName}/g`,
    },
    {
      // For UMReactNativeAdapter
      pattern: `s/${versionPrefix}UM${reactPodName}/${versionPrefix}UMReact/g`,
    },
    {
      // For EXReactNativeAdapter
      pattern: `s/${versionPrefix}EX${reactPodName}/${versionPrefix}EXReact/g`,
    },
    {
      // RCTPlatform exports version of React Native
      pattern: `s/${reactPodName}NativeVersion/reactNativeVersion/g`,
    },
    {
      pattern: `s/@"${versionPrefix}RCT"/@"RCT"/g`,
    },
    {
      // Unversion EXGL-CPP imports: `<ABI28_0_0EXGL-CPP/` => `<EXGL-CPP/`
      pattern: `s/<${versionPrefix}EXGL-CPP\\//<EXGL-CPP\\//g`,
    },
  ];
}

function _getTransformPatternsForDirname(transformRules, dirname) {
  return transformRules.filter((rule) => {
    return (
      // no paths specified, so apply rule to everything
      !rule.paths
      // otherwise, limit this rule to paths specified
      || dirname.indexOf(rule.paths) !== -1
    );
  }).map(rule => rule.pattern);
}

// TODO: use the one in XDL
function _isDirectory(dir) {
  try {
    if (fs.statSync(dir).isDirectory()) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// TODO: use the one in XDL
async function _transformFileContentsAsync(filename, transform) {
  let fileString = await fs.readFile(filename, 'utf8');
  let newFileString = await transform(fileString);
  if (newFileString !== null) {
    await fs.writeFile(filename, newFileString);
  }
  return;
}
