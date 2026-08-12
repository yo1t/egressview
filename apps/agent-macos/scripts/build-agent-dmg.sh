#!/usr/bin/env bash
# Packages the notarised agent as the disk image people actually download.
#
# The ZIP that build-release.sh produces is a developer artefact: double-clicking
# it leaves an app in Downloads, which is the wrong place and the reason
# "unidentified developer" reports keep appearing. A disk image shows the app
# next to an Applications shortcut, so installing it is a drag.
#
# The disk image is notarised in its own right. Stapling the app is not enough:
# a first launch from an unstapled image asks Apple over the network, and the
# first thing a new user sees should not depend on their connection.
#
#   EGRESSVIEW_NOTARY_PROFILE=<keychain profile> ./scripts/build-agent-dmg.sh
#
# Without a notary profile it builds an unnotarised image for local checking and
# says so. Do not publish that one.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
AGENT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DIST_DIR="$AGENT_DIR/dist"
SOURCE_ZIP="${EGRESSVIEW_AGENT_ZIP:-$DIST_DIR/EgressViewAgent.zip}"
NOTARY_PROFILE="${EGRESSVIEW_NOTARY_PROFILE:-}"
APP_NAME="EgressView Agent.app"

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ -f "$SOURCE_ZIP" ]] || fail "No signed build at $SOURCE_ZIP. Run ./scripts/build-release.sh first."

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/egressview-agent-dmg.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

ditto -x -k "$SOURCE_ZIP" "$WORK_DIR/extracted"
APP_PATH="$WORK_DIR/extracted/$APP_NAME"
[[ -d "$APP_PATH" ]] || fail "$SOURCE_ZIP does not contain $APP_NAME"

VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")
[[ -n "$VERSION" ]] || fail 'Could not read the agent version from Info.plist'

# The file name carries the agent's own version, never the Hub's. They are
# separate release lines, and egressview-agent-1.9.0.dmg would read as "for Hub
# 1.9.0 only".
DMG_PATH="$DIST_DIR/egressview-agent-$VERSION.dmg"
[[ -e "$DMG_PATH" ]] && fail "$DMG_PATH already exists. Remove it or bump the version."

# Refuse to package something that would fail on the user's machine. Checking
# here costs a second; finding out from a user costs their evening.
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
if [[ -n "$NOTARY_PROFILE" ]]; then
  xcrun stapler validate "$APP_PATH" || fail 'The app in the ZIP is not stapled. Rebuild with a notary profile.'
  spctl --assess --type execute --verbose=2 "$APP_PATH"
fi

STAGE="$WORK_DIR/stage"
mkdir -p "$STAGE"
ditto "$APP_PATH" "$STAGE/$APP_NAME"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "EgressView Agent $VERSION" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$WORK_DIR/agent.dmg" >/dev/null

if [[ -n "$NOTARY_PROFILE" ]]; then
  # Signing the image itself is what lets the ticket be stapled to it.
  IDENTITY=$(codesign -dvv "$APP_PATH" 2>&1 | sed -n 's/^Authority=\(Developer ID Application.*\)$/\1/p' | head -1)
  [[ -n "$IDENTITY" ]] || fail 'Could not determine the Developer ID identity from the signed app'
  codesign --sign "$IDENTITY" --timestamp "$WORK_DIR/agent.dmg"
  xcrun notarytool submit "$WORK_DIR/agent.dmg" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$WORK_DIR/agent.dmg"
  xcrun stapler validate "$WORK_DIR/agent.dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$WORK_DIR/agent.dmg"
else
  printf 'No EGRESSVIEW_NOTARY_PROFILE: built an unnotarised image for local checking only. Do not publish it.\n' >&2
fi

mv "$WORK_DIR/agent.dmg" "$DMG_PATH"
shasum -a 256 "$DMG_PATH"
printf 'Disk image: %s\n' "$DMG_PATH"
