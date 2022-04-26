#!/usr/bin/osascript -l JavaScript

// String -> String
function envVar(varName) {
  return $.NSProcessInfo.processInfo.environment.objectForKey(varName).js
}

// String -> ()
function mkpath(path) {
  $.NSFileManager
    .defaultManager
    .createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, undefined, undefined)
}

// String, String -> ()
function writeFile(path, text) {
  $.NSString
    .alloc
    .initWithUTF8String(text)
    .writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)
}

// [String] -> String
function runCommand(arguments) {
  const task = $.NSTask.alloc.init
  const stdout = $.NSPipe.pipe

  task.executableURL = $.NSURL.alloc.initFileURLWithPath(arguments[0])
  task.arguments = arguments.slice(1)
  task.standardOutput = stdout
  task.launchAndReturnError(false)

  const dataOut = stdout.fileHandleForReading.readDataToEndOfFile
  const stringOut = $.NSString.alloc.initWithDataEncoding(dataOut, $.NSUTF8StringEncoding).js

  return stringOut
}

// String... -> String
function runOP(...arguments) {
  const command = [opPath(), "--cache"]
  const format = ["--format", "json"]

  return JSON.parse(runCommand(command.concat(arguments, format)))
}

// () -> [String]
function getUserIDs() {
  return runOP("account", "list")
    .map(account => account["user_uuid"])
    .filter(item => item !== undefined)
}

// String -> [Object]
function getItems(userID, excludedVaults) {
  const vaults = runOP("vault", "list", "--account", userID)
  const accountID = runOP("account", "get", "--account", userID)["id"]

  return runOP("item", "list", "--account", userID).map(item => {
    const vaultID = item["vault"]["id"]

    if (excludedVaults.includes(vaultID)) return
    if (envVar("logins_only") === "1" && item["category"] !== "LOGIN") return

    const vaultName = vaults.find(vault => vault["id"] === vaultID)["name"]
    const url = item["urls"]?.[0]["href"]

    return {
      uid: item["id"],
      title: item["title"],
      subtitle: url ? url + " 𐄁 " + vaultName : vaultName,
      variables: {
        accountID: accountID,
        vaultID: vaultID,
        itemID: item["id"],
        url: url
      }
    }
  }).filter(item => item !== undefined) // Remove skipped items (excluded vaults or non-logins)
}

// () -> [String]
function getExcludedVaults(filePath) {
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(filePath)) return []

  return readJSON(filePath)["items"]
    .filter(item => item["variables"]["excluded"])
    .map(item => item["variables"]["vaultID"])
}

// String -> [Object]
function getVaults(userID, excludedVaults) {
  const account = runOP("account", "list", "--account", userID)[0]
  const accountShorthand = account["shorthand"]
  const accountEmail = account["email"]
  const accountURL = account["url"]

  return runOP("vault", "list", "--account", userID).map(vault => {
    const vaultID = vault["id"]
    const excluded = excludedVaults.includes(vaultID)
    const mark = excluded ? "✗" : "✓"

    return {
      uid: vaultID,
      title: mark + " " + vault["name"],
      subtitle: accountShorthand + " 𐄁 " + accountEmail + " 𐄁 " + accountURL,
      arg: vaultID,
      variables: {
        excluded: excluded,
        vaultID: vaultID
      }
    }
  })
}

// String -> ()
function flipVaultExclusion(filePath, vaultID) {
  const sfObject = readJSON(filePath)

  const sfItems = sfObject["items"].map(item => {
    if (item["variables"]["vaultID"] !== vaultID) return item

    const flippedState = !item["variables"]["excluded"]
    const titleNoMark = item["title"].substring(2)
    const title = (flippedState ? "✗": "✓") + " " + titleNoMark

    item["title"] = title
    item["variables"]["excluded"] = flippedState

    return item
  })

  writeJSON(filePath, {rerun: 0.1, items: sfItems})
}

// String -> ()
function prependDataUpdate(filePath) {
  const sfObject = readJSON(filePath)

  if (sfObject["items"][0]["arg"] == "update_items") return // Return early if update entry exists

  sfObject["items"].forEach(item => item["uid"] = "") // Remove uids so Alfred does not sort

  sfObject["items"].unshift({
    uid: "Update Items",
    title: "Update items",
    subtitle: "Your terminal will open with instructions",
    arg: "update_items"
  })

  writeJSON(filePath, sfObject)
}

// () -> String
function opPath() {
  const installedViaPkg = "/usr/local/bin/op"

  // Only return user-installed CLI if necessary (biometric unlock enabled)
  if (biometricUnlockEnabled() && $.NSFileManager.defaultManager.isExecutableFileAtPath(installedViaPkg)) return installedViaPkg

  // By default, use the command-line included in the Workflow
  return "./op"
}

// () -> Bool
function biometricUnlockEnabled() {
  const settingsFile = $("~/Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data/settings/settings.json").stringByExpandingTildeInPath.js

  if (!$.NSFileManager.defaultManager.fileExistsAtPath(settingsFile)) return false
  if (readJSON(settingsFile)["developers.cliSharedLockState.enabled"]) return true
  return false
}

// String, [String] -> ()
function writeJSON(filePath, sfObject) {
  mkpath($(filePath).stringByDeletingLastPathComponent.js)
  writeFile(filePath, JSON.stringify(sfObject))
}

// String -> [Object]
function readJSON(filePath) {
  const data = $.NSFileManager.defaultManager.contentsAtPath(filePath)
  const string = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  return JSON.parse(string)
}

function run(argv) {
  const itemsFile = envVar("alfred_workflow_data") + "/items.json"
  const vaultsFile = envVar("alfred_workflow_data") + "/vaults.json"

  switch (argv[0]) {
    case "update_items":
      const excludedVaults = getExcludedVaults(vaultsFile)
      const sfItems = getUserIDs().flatMap(userID => getItems(userID, excludedVaults))

      const sfVaults = getUserIDs().flatMap(userID => getVaults(userID, excludedVaults))
        .concat({
          title: "Update items",
          subtitle: "Your terminal will open with instructions",
          arg: "update_items",
          variables: {excluded: false, vaultID: false} // Avoid "undefined" errors in fuctions which interact with vaults file
        })

      writeJSON(itemsFile, {items: sfItems})
      writeJSON(vaultsFile, {rerun: 0.1, items: sfVaults})
      break
    case "flip_vault_exclusion":
      return flipVaultExclusion(vaultsFile, argv[1])
    case "print_user_ids":
      return getUserIDs().join(",")
    case "data_update_detected":
      return prependDataUpdate(itemsFile)
    case "biometric_unlock_enabled":
      return biometricUnlockEnabled()
    case "op_path":
      return opPath()
    default:
      console.log("Unrecognised argument")
  }
}
