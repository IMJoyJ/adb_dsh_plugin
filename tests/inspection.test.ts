import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseAppInspection,
  parseBinderServices,
  parseDumpsysServices,
  parseInstalledPackages,
  parsePackagePaths,
} from '../src/inspection.js'

test('parseInstalledPackages extracts paths and package metadata', () => {
  assert.deepEqual(parseInstalledPackages(`package:/data/app/~~token/base.apk=com.example.notes versionCode:42 installer=com.android.vending uid:10123
package:/system/priv-app/Settings/Settings.apk=com.android.settings versionCode:35 installer=null uid:1000
package:com.example.legacy
noise
`), [
    {
      packageName: 'com.example.notes',
      apkPath: '/data/app/~~token/base.apk',
      versionCode: '42',
      installer: 'com.android.vending',
      uid: '10123',
    },
    {
      packageName: 'com.android.settings',
      apkPath: '/system/priv-app/Settings/Settings.apk',
      versionCode: '35',
      uid: '1000',
    },
    { packageName: 'com.example.legacy' },
  ])
})

test('service parsers cover Binder descriptors and dumpsys names', () => {
  assert.deepEqual(parseBinderServices(`Found 3 services:
0\tSurfaceFlinger: [android.ui.ISurfaceComposer]
1  activity: [android.app.IActivityManager]
2  vendor.example/default: []
`), [
    { index: 0, name: 'SurfaceFlinger', descriptor: 'android.ui.ISurfaceComposer' },
    { index: 1, name: 'activity', descriptor: 'android.app.IActivityManager' },
    { index: 2, name: 'vendor.example/default' },
  ])
  assert.deepEqual(parseDumpsysServices('Currently running services:\n activity\n package\n activity\n\n'), ['activity', 'package'])
})

test('parsePackagePaths extracts base and split APKs', () => {
  assert.deepEqual(parsePackagePaths('package:/data/app/base.apk\npackage:/data/app/split_config.apk\n'), [
    '/data/app/base.apk',
    '/data/app/split_config.apk',
  ])
})

test('parseAppInspection structures summary, permissions, and all component types', () => {
  const output = `
Activity Resolver Table:
  Non-Data Actions:
      android.intent.action.MAIN:
        aabbcc com.example.notes/.MainActivity filter

Packages:
  Package [com.example.notes] (123abc):
    appId=10123
    codePath=/data/app/~~token/com.example.notes
    versionCode=42 minSdk=24 targetSdk=35
    versionName=2.1.0
    dataDir=/data/user/0/com.example.notes
    primaryCpuAbi=arm64-v8a
    secondaryCpuAbi=null
    firstInstallTime=2026-08-01 10:20:30
    lastUpdateTime=2026-08-14 18:00:00
    installerPackageName=com.android.vending
    requested permissions:
      android.permission.INTERNET
      android.permission.POST_NOTIFICATIONS
    install permissions:
      android.permission.INTERNET: granted=true
    activities:
      com.example.notes/.MainActivity
      com.example.notes/.SettingsActivity
    services:
      com.example.notes/.SyncService
    receivers:
      com.example.notes/.BootReceiver
    providers:
      com.example.notes/.NotesProvider
    User 0: installed=true hidden=false
      runtime permissions:
        android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SET|USER_SENSITIVE_WHEN_DENIED]
      disabledComponents:
        com.example.notes.SettingsActivity
      enabledComponents:
        .BootReceiver
Hidden system packages:
  Package [com.example.notes] (old):
    requested permissions:
      android.permission.OLD_PERMISSION
    activities:
      com.example.notes/.RemovedFactoryActivity
`
  assert.deepEqual(parseAppInspection(output, 'com.example.notes'), {
    summary: {
      versionName: '2.1.0',
      versionCode: '42',
      minSdk: '24',
      targetSdk: '35',
      appId: '10123',
      codePath: '/data/app/~~token/com.example.notes',
      dataDir: '/data/user/0/com.example.notes',
      primaryCpuAbi: 'arm64-v8a',
      firstInstallTime: '2026-08-01 10:20:30',
      lastUpdateTime: '2026-08-14 18:00:00',
      installerPackageName: 'com.android.vending',
    },
    requestedPermissions: ['android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS'],
    permissionStates: [
      { name: 'android.permission.INTERNET', scope: 'install', granted: true, flags: [] },
      {
        name: 'android.permission.POST_NOTIFICATIONS',
        scope: 'runtime',
        granted: false,
        flags: ['USER_SET', 'USER_SENSITIVE_WHEN_DENIED'],
        userId: 0,
      },
    ],
    components: {
      activities: ['com.example.notes/.MainActivity', 'com.example.notes/.SettingsActivity'],
      services: ['com.example.notes/.SyncService'],
      receivers: ['com.example.notes/.BootReceiver'],
      providers: ['com.example.notes/.NotesProvider'],
    },
    disabledComponents: ['com.example.notes/.SettingsActivity'],
    enabledComponents: ['com.example.notes/.BootReceiver'],
  })
})
