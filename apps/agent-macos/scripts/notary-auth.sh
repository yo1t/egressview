# Notarisation credentials for the release scripts. Sourced, not run.
#
# Two ways to authenticate `notarytool`:
#
#   EGRESSVIEW_NOTARY_PROFILE=<keychain profile>
#     A profile saved with `notarytool store-credentials`. It lives in the data
#     protection keychain, which is locked while the Mac's screen is locked --
#     and a locked keychain is reported as "No Keychain password item found".
#     The profile is almost never gone: on 2026-09-26 every failed check fell
#     in a stretch with the screen off or locked, and every one that passed came
#     right after someone was back at the Mac (P3-172). It was re-registered
#     eight times on the strength of that message.
#
#   EGRESSVIEW_NOTARY_KEY=<path to AuthKey_XXXX.p8>
#   EGRESSVIEW_NOTARY_KEY_ID=<key id>  EGRESSVIEW_NOTARY_ISSUER=<issuer uuid>
#     An App Store Connect API key. A file, not a keychain item, so it works
#     with the screen locked -- the way to run a release unattended. The file
#     is a secret: keep it outside the repository, readable by you only.
#
# After sourcing: NOTARY_ARGS holds the arguments for `notarytool`, and
# NOTARY_MODE is "profile", "key" or empty (no notarisation configured).

NOTARY_PROFILE="${EGRESSVIEW_NOTARY_PROFILE:-}"
NOTARY_KEY="${EGRESSVIEW_NOTARY_KEY:-}"
NOTARY_KEY_ID="${EGRESSVIEW_NOTARY_KEY_ID:-}"
NOTARY_ISSUER="${EGRESSVIEW_NOTARY_ISSUER:-}"
NOTARY_MODE=""
NOTARY_ARGS=()

if [[ -n "$NOTARY_KEY" ]]; then
  if [[ -z "$NOTARY_KEY_ID" || -z "$NOTARY_ISSUER" ]]; then
    printf 'EGRESSVIEW_NOTARY_KEY needs EGRESSVIEW_NOTARY_KEY_ID and EGRESSVIEW_NOTARY_ISSUER as well.\n' >&2
    exit 2
  fi
  NOTARY_MODE="key"
  NOTARY_ARGS=(--key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
elif [[ -n "$NOTARY_PROFILE" ]]; then
  NOTARY_MODE="profile"
  NOTARY_ARGS=(--keychain-profile "$NOTARY_PROFILE")
fi

# Checked before the build, not after it: finding out at the end costs the
# whole build -- twice on 2026-08-19.
check_notary_credentials() {
  [[ -n "$NOTARY_MODE" ]] || return 0
  if [[ "$NOTARY_MODE" == "key" ]]; then
    if [[ ! -r "$NOTARY_KEY" ]]; then
      printf 'The App Store Connect API key cannot be read: %s\n' "$NOTARY_KEY" >&2
      exit 2
    fi
    # Anyone who can read it can notarise as you.
    if [[ -n "$(find "$NOTARY_KEY" -perm -g+r -o -perm -o+r 2>/dev/null)" ]]; then
      printf 'The API key is readable by other users. Restrict it and run this again:\n' >&2
      printf '  chmod 600 %q\n' "$NOTARY_KEY" >&2
      exit 2
    fi
  fi
  if xcrun notarytool history "${NOTARY_ARGS[@]}" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$NOTARY_MODE" == "profile" ]]; then
    printf 'Notarisation profile "%s" cannot be read.\n' "$NOTARY_PROFILE" >&2
    printf '\nAlmost always the profile is there and the keychain is locked -- the\n' >&2
    printf 'screen is locked, or was, and notarytool reports that as a missing item.\n' >&2
    printf 'Unlock the Mac (or run: security unlock-keychain) and run this again.\n' >&2
    printf '\nOnly if that does not help, register the profile again:\n' >&2
    printf '  xcrun notarytool store-credentials %s --apple-id <apple-id> --team-id <team-id>\n' "$NOTARY_PROFILE" >&2
    printf '\nTo notarise with the screen locked, use an App Store Connect API key instead\n' >&2
    printf '(EGRESSVIEW_NOTARY_KEY, _KEY_ID, _ISSUER; see scripts/notary-auth.sh).\n' >&2
  else
    printf 'Apple did not accept the App Store Connect API key (id %s).\n' "$NOTARY_KEY_ID" >&2
    printf 'Check the key id, the issuer id and that the key has not been revoked.\n' >&2
  fi
  exit 2
}
