import { writeJson, type Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ANDROID_TOOLCHAIN = {
  gradle: '8.13',
  distributionSha256:
    '20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78',
  wrapperSha256:
    '81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f',
  agp: '8.13.2',
  kotlin: '2.2.10',
  composeBom: '2025.08.01',
  activityCompose: '1.10.1',
  compileSdk: 36,
  targetSdk: 36,
  minSdk: 26,
} as const;

// Prefix each component so digit-leading names and Kotlin keywords are safe.
export function defaultAndroidApplicationId(
  scope: string,
  name: string,
): string {
  return `com.${[scope, name].map((part) => `app_${part.replaceAll('-', '_')}`).join('.')}`;
}

export function validateAndroidApplicationId(value: string): void {
  const keywords = new Set(
    'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while'.split(
      ' ',
    ),
  );
  if (
    !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value) ||
    value.split('.').some((part) => keywords.has(part))
  ) {
    throw new Error(
      'Android applicationId must be a lowercase dotted identifier with letter-leading components, excluding Kotlin keywords.',
    );
  }
}

export function createAndroidApp(
  tree: Tree,
  options: {
    directory: string;
    projectName: string;
    name: string;
    scope: string;
    displayName?: string;
    applicationId?: string;
    tags: readonly string[];
  },
): void {
  const root = options.directory;
  const id =
    options.applicationId ??
    defaultAndroidApplicationId(options.scope, options.name);
  validateAndroidApplicationId(id);
  const title = options.displayName ?? options.name;
  const kotlinTitle = JSON.stringify(title).replaceAll('$', '\\$');
  const xmlTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
  const assets = join(__dirname, 'android-assets');
  const wrapper = Buffer.from(
    readFileSync(join(assets, 'gradle-wrapper.jar.base64'), 'utf8'),
    'base64',
  );
  if (
    createHash('sha256').update(wrapper).digest('hex') !==
    ANDROID_TOOLCHAIN.wrapperSha256
  ) {
    throw new Error(
      'Bundled Gradle wrapper checksum mismatch. No Android files were written.',
    );
  }
  const write = (path: string, content: string | Buffer) =>
    tree.write(`${root}/${path}`, content);
  write('gradle/wrapper/gradle-wrapper.jar', wrapper);
  for (const file of ['gradlew', 'gradlew.bat', 'LICENSE']) {
    write(
      file === 'LICENSE' ? 'gradle/LICENSE' : file,
      readFileSync(join(assets, file), 'utf8'),
    );
  }
  tree.changePermissions(`${root}/gradlew`, 0o755);
  write(
    'gradle/wrapper/gradle-wrapper.properties',
    `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${ANDROID_TOOLCHAIN.gradle}-bin.zip
distributionSha256Sum=${ANDROID_TOOLCHAIN.distributionSha256}
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,
  );
  write(
    'gradle.mjs',
    `import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const java = process.env.JAVA_HOME
  ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'java';
const result = spawnSync(java, [
  '-classpath', join(root, 'gradle/wrapper/gradle-wrapper.jar'),
  'org.gradle.wrapper.GradleWrapperMain', ...process.argv.slice(2),
], { cwd: root, stdio: 'inherit', shell: false });
if (result.error) console.error('Android tasks require JDK 17 or newer. Set JAVA_HOME to the JDK directory.', result.error.message);
process.exitCode = result.status ?? 1;
`,
  );
  write(
    'settings.gradle.kts',
    `pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "${options.projectName}"
include(":app")
`,
  );
  write(
    'build.gradle.kts',
    `plugins {
    id("com.android.application") version "${ANDROID_TOOLCHAIN.agp}" apply false
    id("org.jetbrains.kotlin.android") version "${ANDROID_TOOLCHAIN.kotlin}" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "${ANDROID_TOOLCHAIN.kotlin}" apply false
}
`,
  );
  write(
    'gradle.properties',
    'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nkotlin.code.style=official\n',
  );
  write(
    '.gitignore',
    '.gradle/\n.kotlin/\n**/build/\nlocal.properties\n.idea/\n*.iml\n*.jks\n*.keystore\n',
  );
  write(
    'app/build.gradle.kts',
    `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "${id}"
    compileSdk = ${ANDROID_TOOLCHAIN.compileSdk}
    defaultConfig {
        applicationId = "${id}"
        minSdk = ${ANDROID_TOOLCHAIN.minSdk}
        targetSdk = ${ANDROID_TOOLCHAIN.targetSdk}
        versionCode = 1
        versionName = "1.0"
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies {
    implementation(platform("androidx.compose:compose-bom:${ANDROID_TOOLCHAIN.composeBom}"))
    implementation("androidx.activity:activity-compose:${ANDROID_TOOLCHAIN.activityCompose}")
    implementation("androidx.compose.material3:material3")
    testImplementation("junit:junit:4.13.2")
}
`,
  );
  write(
    'app/src/main/AndroidManifest.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="${xmlTitle}" android:allowBackup="false" android:supportsRtl="true" android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,
  );
  const source = id.replaceAll('.', '/');
  write(
    `app/src/main/java/${source}/MainActivity.kt`,
    `package ${id}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

object AppFeature { const val title = ${kotlinTitle} }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Box(modifier = Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
                        Text(AppFeature.title, style = MaterialTheme.typography.headlineMedium)
                    }
                }
            }
        }
    }
}
`,
  );
  write(
    `app/src/test/java/${source}/AppFeatureTest.kt`,
    `package ${id}

import org.junit.Assert.assertTrue
import org.junit.Test

class AppFeatureTest {
    @Test fun applicationTitleIsConfigured() {
        assertTrue(AppFeature.title.isNotBlank())
    }
}
`,
  );
  writeJson(tree, `${root}/project.json`, {
    name: options.projectName,
    projectType: 'application',
    sourceRoot: `${root}/app/src`,
    tags: options.tags,
    targets: Object.fromEntries(
      Object.entries({
        build: ':app:assembleDebug',
        test: ':app:testDebugUnitTest',
        lint: ':app:lintDebug',
        install: ':app:installDebug',
      }).map(([name, task]) => [
        name,
        {
          executor: 'nx:run-commands',
          cache: false,
          parallelism: false,
          options: {
            command: `node gradle.mjs ${task}`,
            cwd: root,
            forwardAllArgs: false,
          },
        },
      ]),
    ),
  });
  write(
    'README.md',
    `# ${options.projectName}

Native Android application in Kotlin with Jetpack Compose. Open this directory in Android Studio.

## Requirements

- JDK 17 (set JAVA_HOME); Gradle ${ANDROID_TOOLCHAIN.gradle} is downloaded by the checksum-pinned wrapper on first use.
- Android SDK platform ${ANDROID_TOOLCHAIN.compileSdk} and build tools 35.0.0. Set ANDROID_HOME or use Android Studio's untracked local.properties.
- Accept SDK licenses yourself. Generation does not install an SDK, accept licenses, start an emulator, or contact a device.

From the repository root, run your package manager's Nx command:

- nx run ${options.projectName}:build — debug APK
- nx run ${options.projectName}:test — JVM unit tests (not device tests)
- nx run ${options.projectName}:lint — Android Lint
- nx run ${options.projectName}:install — install the debug APK onto an already-connected emulator/device (does not launch it)

For Gradle directly on any host: node gradle.mjs :app:assembleDebug. Standard wrappers are also included: sh gradlew on Unix, gradlew.bat on Windows.

Application ID/namespace: ${id}. Change both in app/build.gradle.kts and move/update Kotlin packages if renaming it. Signing keys, release signing, Play publication, CI SDK provisioning, and device/UI qualification remain application-owned. No network permissions are requested.

Nx caching is deliberately disabled for native targets until JDK/SDK/environment and signing inputs have been reviewed. Gradle retains its own incremental build behavior. Same-project Nx tasks are serialized to protect shared Gradle outputs.

The bundled Gradle wrapper is from Gradle v8.13.0, Apache-2.0; see gradle/LICENSE. Gradle/AGP compatibility: https://developer.android.com/build/releases/agp-8-13-0-release-notes
`,
  );
}
