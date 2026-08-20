#!/usr/bin/env bash

set -euo pipefail

require_env() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s\n' "$name" >&2
    exit 2
  fi
}

require_env EGRESSVIEW_DEVELOPMENT_TEAM
require_env EGRESSVIEW_HOST_PROFILE
require_env EGRESSVIEW_FILTER_PROFILE

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_DIR=${EGRESSVIEW_RELEASE_OUTPUT_DIR:-"$PROJECT_DIR/dist"}
SIGN_IDENTITY=${EGRESSVIEW_SIGN_IDENTITY:-Developer ID Application}
ARCHS=${EGRESSVIEW_ARCHS:-arm64}
NOTARY_PROFILE=${EGRESSVIEW_NOTARY_PROFILE:-}
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/egressview-macos-release.XXXXXX")
ARCHIVE_PATH="$WORK_DIR/EgressViewAgent.xcarchive"
DERIVED_DATA="$WORK_DIR/DerivedData"
APP_PATH="$ARCHIVE_PATH/Products/Applications/EgressView Agent.app"
EXTENSION_PATH="$APP_PATH/Contents/Library/SystemExtensions/com.egressview.agent.filter.systemextension"
SUBMISSION_ZIP="$WORK_DIR/EgressViewAgent-notary.zip"
RELEASE_ZIP="$WORK_DIR/EgressViewAgent-release.zip"
ROUNDTRIP_DIR="$WORK_DIR/roundtrip"
OUTPUT_ZIP="$OUTPUT_DIR/EgressViewAgent.zip"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

# Checked before the build, not after it. The notarisation profile has gone
# missing five times, and finding out at the end costs the whole build --
# twice on 2026-08-19. Its cause is not worth chasing; the wait is.
if [[ -n "$NOTARY_PROFILE" ]]; then
  if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    printf 'Notarisation profile "%s" is not usable. Register it and run this again:\n' "$NOTARY_PROFILE" >&2
    printf '  xcrun notarytool store-credentials %s --apple-id <apple-id> --team-id <team-id>\n' "$NOTARY_PROFILE" >&2
    exit 2
  fi
fi

mkdir -p -- "$OUTPUT_DIR"
if [[ -e "$OUTPUT_ZIP" ]]; then
  printf 'Refusing to overwrite existing release: %s\n' "$OUTPUT_ZIP" >&2
  exit 2
fi

xcodebuild -quiet \
  -project "$PROJECT_DIR/EgressViewAgent.xcodeproj" \
  -scheme 'EgressView Agent' \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath "$ARCHIVE_PATH" \
  -derivedDataPath "$DERIVED_DATA" \
  EGRESSVIEW_DEVELOPMENT_TEAM="$EGRESSVIEW_DEVELOPMENT_TEAM" \
  EGRESSVIEW_SIGN_IDENTITY="$SIGN_IDENTITY" \
  EGRESSVIEW_HOST_PROFILE="$EGRESSVIEW_HOST_PROFILE" \
  EGRESSVIEW_FILTER_PROFILE="$EGRESSVIEW_FILTER_PROFILE" \
  ARCHS="$ARCHS" \
  archive

[[ -d "$APP_PATH" ]] || { printf 'Host app missing from archive\n' >&2; exit 1; }
[[ -d "$EXTENSION_PATH" ]] || { printf 'System Extension missing from archive\n' >&2; exit 1; }
EXPECTED_MACH_SERVICE_NAME="group.com.egressview.agent.xpc"
[[ "$(plutil -extract NetworkExtension.NEMachServiceName raw "$EXTENSION_PATH/Contents/Info.plist")" == "$EXPECTED_MACH_SERVICE_NAME" ]] || {
  printf 'System Extension XPC service name is invalid\n' >&2
  exit 1
}
if plutil -extract NEMachServiceName raw "$EXTENSION_PATH/Contents/Info.plist" >/dev/null 2>&1; then
  printf 'System Extension XPC service name must be inside NetworkExtension\n' >&2
  exit 1
fi

HOST_XCENT=$(find "$DERIVED_DATA" -name 'EgressView Agent.app.xcent' -print -quit)
EXTENSION_XCENT=$(find "$DERIVED_DATA" -name '*.systemextension.xcent' -print -quit)
[[ -f "$HOST_XCENT" ]] || { printf 'Host signing entitlements missing\n' >&2; exit 1; }
[[ -f "$EXTENSION_XCENT" ]] || { printf 'System Extension signing entitlements missing\n' >&2; exit 1; }

# Sign the completed bundles inside-out. Xcode 26 can mutate archive products
# after its CodeSign phase, so the release gate verifies the final bytes.
codesign --force --sign "$SIGN_IDENTITY" --options runtime --timestamp \
  --generate-entitlement-der \
  --entitlements "$EXTENSION_XCENT" "$EXTENSION_PATH"
codesign --verify --strict --verbose=2 "$EXTENSION_PATH"

codesign --force --sign "$SIGN_IDENTITY" --options runtime --timestamp \
  --generate-entitlement-der \
  --entitlements "$HOST_XCENT" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

HOST_ENTITLEMENTS="$WORK_DIR/host-entitlements.plist"
EXTENSION_ENTITLEMENTS="$WORK_DIR/extension-entitlements.plist"
codesign -d --xml --entitlements "$HOST_ENTITLEMENTS" "$APP_PATH"
codesign -d --xml --entitlements "$EXTENSION_ENTITLEMENTS" "$EXTENSION_PATH"

[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.system-extension.install' "$HOST_ENTITLEMENTS")" == true ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$HOST_ENTITLEMENTS")" == true ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.network.client' "$HOST_ENTITLEMENTS")" == true ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$EXTENSION_ENTITLEMENTS")" == true ]]
/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.networking.networkextension' "$HOST_ENTITLEMENTS" | grep -q 'content-filter-provider-systemextension'
/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.networking.networkextension' "$EXTENSION_ENTITLEMENTS" | grep -q 'content-filter-provider-systemextension'
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups' "$HOST_ENTITLEMENTS" | grep -q 'group.com.egressview.agent'
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups' "$EXTENSION_ENTITLEMENTS" | grep -q 'group.com.egressview.agent'
if /usr/libexec/PlistBuddy -c 'Print :com.apple.security.xpc.mach-service.name' "$EXTENSION_ENTITLEMENTS" >/dev/null 2>&1; then
  printf 'System Extension contains an unsupported explicit Mach service entitlement\n' >&2
  exit 1
fi
for forbidden in \
  com.apple.security.network.server \
  com.apple.security.temporary-exception.files.absolute-path.read-only \
  com.apple.security.temporary-exception.files.absolute-path.read-write \
  com.apple.security.temporary-exception.files.home-relative-path.read-only \
  com.apple.security.temporary-exception.files.home-relative-path.read-write; do
  if /usr/libexec/PlistBuddy -c "Print :$forbidden" "$HOST_ENTITLEMENTS" >/dev/null 2>&1; then
    printf 'Host contains forbidden sandbox entitlement: %s\n' "$forbidden" >&2
    exit 1
  fi
done

ditto -c -k --keepParent "$APP_PATH" "$SUBMISSION_ZIP"

if [[ -n "$NOTARY_PROFILE" ]]; then
  xcrun notarytool submit "$SUBMISSION_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP_PATH"
  xcrun stapler validate "$APP_PATH"
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  spctl --assess --type execute --verbose=2 "$APP_PATH"
fi

# Verify the exact bytes users will extract before publishing the artifact.
ditto -c -k --keepParent "$APP_PATH" "$RELEASE_ZIP"
mkdir -p -- "$ROUNDTRIP_DIR"
ditto -x -k "$RELEASE_ZIP" "$ROUNDTRIP_DIR"

ROUNDTRIP_APP="$ROUNDTRIP_DIR/EgressView Agent.app"
ROUNDTRIP_EXTENSION="$ROUNDTRIP_APP/Contents/Library/SystemExtensions/com.egressview.agent.filter.systemextension"
[[ -d "$ROUNDTRIP_APP" ]] || { printf 'Host app missing after ZIP extraction\n' >&2; exit 1; }
[[ -d "$ROUNDTRIP_EXTENSION" ]] || { printf 'System Extension missing after ZIP extraction\n' >&2; exit 1; }
[[ "$(plutil -extract NetworkExtension.NEMachServiceName raw "$ROUNDTRIP_EXTENSION/Contents/Info.plist")" == "$EXPECTED_MACH_SERVICE_NAME" ]] || {
  printf 'System Extension XPC service name is invalid after ZIP extraction\n' >&2
  exit 1
}
if plutil -extract NEMachServiceName raw "$ROUNDTRIP_EXTENSION/Contents/Info.plist" >/dev/null 2>&1; then
  printf 'System Extension XPC service name must remain inside NetworkExtension after ZIP extraction\n' >&2
  exit 1
fi

codesign --verify --strict --verbose=2 "$ROUNDTRIP_EXTENSION"
codesign --verify --deep --strict --verbose=2 "$ROUNDTRIP_APP"

ROUNDTRIP_HOST_ENTITLEMENTS="$WORK_DIR/roundtrip-host-entitlements.plist"
ROUNDTRIP_EXTENSION_ENTITLEMENTS="$WORK_DIR/roundtrip-extension-entitlements.plist"
codesign -d --xml --entitlements "$ROUNDTRIP_HOST_ENTITLEMENTS" "$ROUNDTRIP_APP"
codesign -d --xml --entitlements "$ROUNDTRIP_EXTENSION_ENTITLEMENTS" "$ROUNDTRIP_EXTENSION"

[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.system-extension.install' "$ROUNDTRIP_HOST_ENTITLEMENTS")" == true ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$ROUNDTRIP_HOST_ENTITLEMENTS")" == true ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.network.client' "$ROUNDTRIP_HOST_ENTITLEMENTS")" == true ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$ROUNDTRIP_EXTENSION_ENTITLEMENTS")" == true ]]
/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.networking.networkextension' "$ROUNDTRIP_HOST_ENTITLEMENTS" | grep -q 'content-filter-provider-systemextension'
/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.networking.networkextension' "$ROUNDTRIP_EXTENSION_ENTITLEMENTS" | grep -q 'content-filter-provider-systemextension'
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups' "$ROUNDTRIP_HOST_ENTITLEMENTS" | grep -q 'group.com.egressview.agent'
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups' "$ROUNDTRIP_EXTENSION_ENTITLEMENTS" | grep -q 'group.com.egressview.agent'
if /usr/libexec/PlistBuddy -c 'Print :com.apple.security.xpc.mach-service.name' "$ROUNDTRIP_EXTENSION_ENTITLEMENTS" >/dev/null 2>&1; then
  printf 'Round-trip System Extension contains an unsupported explicit Mach service entitlement\n' >&2
  exit 1
fi
for forbidden in \
  com.apple.security.network.server \
  com.apple.security.temporary-exception.files.absolute-path.read-only \
  com.apple.security.temporary-exception.files.absolute-path.read-write \
  com.apple.security.temporary-exception.files.home-relative-path.read-only \
  com.apple.security.temporary-exception.files.home-relative-path.read-write; do
  if /usr/libexec/PlistBuddy -c "Print :$forbidden" "$ROUNDTRIP_HOST_ENTITLEMENTS" >/dev/null 2>&1; then
    printf 'Round-trip host contains forbidden sandbox entitlement: %s\n' "$forbidden" >&2
    exit 1
  fi
done

if [[ -n "$NOTARY_PROFILE" ]]; then
  xcrun stapler validate "$ROUNDTRIP_APP"
  spctl --assess --type execute --verbose=2 "$ROUNDTRIP_APP"
fi

cp -p -- "$RELEASE_ZIP" "$OUTPUT_ZIP"
shasum -a 256 "$OUTPUT_ZIP"
printf 'Release package: %s\n' "$OUTPUT_ZIP"
