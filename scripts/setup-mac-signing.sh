#!/usr/bin/env bash
#
# Uploads the five macOS code-signing secrets this repo's release workflow
# looks for. Run once, after you have a Developer ID Application certificate
# installed in your keychain.
#
#     ./scripts/setup-mac-signing.sh path/to/DeveloperID.p12
#
# What it does NOT do: create the certificate. That needs Keychain Access and
# the Apple Developer portal, and the steps are in the README's Signing
# section. This script only handles the part that is easy to get wrong --
# base64-encoding the .p12 without a trailing newline, and setting all five
# secrets with the exact names the workflow reads.
#
# Nothing here echoes a secret. Values are piped straight into `gh secret set`,
# which sends them over TLS and stores them encrypted; they never appear in
# your shell history or in this script's output.
set -euo pipefail

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run 'gh auth login' first" >&2; exit 1; }

# With no argument, export the certificate straight out of the keychain.
#
# That is the normal path when Xcode created it (Settings -> Accounts ->
# Manage Certificates -> + -> Developer ID Application), which installs it
# directly and is by far the easiest way to get one. Passing a .p12 explicitly
# still works, for a certificate obtained some other way.
P12="${1:-}"
TEMP_P12=""
if [ -z "$P12" ]; then
  COUNT="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -c "Developer ID Application" || true)"
  if [ "$COUNT" -eq 0 ]; then
    echo "No 'Developer ID Application' certificate found in your keychain." >&2
    echo >&2
    echo "Easiest way to get one, since Xcode is installed:" >&2
    echo "  Xcode -> Settings -> Accounts -> add your Apple ID -> select the" >&2
    echo "  team -> Manage Certificates... -> + -> Developer ID Application" >&2
    echo >&2
    echo "Then re-run this with no arguments. Or pass a .p12 explicitly:" >&2
    echo "  $0 path/to/DeveloperID.p12" >&2
    exit 1
  fi
  if [ "$COUNT" -gt 1 ]; then
    echo "More than one Developer ID Application certificate is installed:" >&2
    security find-identity -v -p codesigning | grep "Developer ID Application" >&2
    echo >&2
    echo "Export the one you want from Keychain Access and pass it explicitly," >&2
    echo "so this cannot upload the wrong identity." >&2
    exit 1
  fi

  echo "Found one Developer ID Application certificate; exporting it."
  echo "macOS will ask for your login password to release the private key."
  TEMP_P12="$(mktemp -t pagedown-signing).p12"
  # A random transport password. It is only ever used to move the certificate
  # from keychain to GitHub, and it is uploaded alongside as
  # MAC_CERT_PASSWORD, so it never needs to be memorable or reused.
  EXPORT_PW="$(openssl rand -base64 24)"
  if ! security export -t identities -f pkcs12 -P "$EXPORT_PW" -o "$TEMP_P12" 2>/dev/null; then
    rm -f "$TEMP_P12"
    echo "Keychain export failed -- macOS may have denied access." >&2
    echo "Export manually from Keychain Access and pass the .p12 to this script." >&2
    exit 1
  fi
  P12="$TEMP_P12"
  PRESET_PW="$EXPORT_PW"
fi
# The temp .p12 holds a private key; remove it however this script exits.
trap '[ -n "$TEMP_P12" ] && rm -f "$TEMP_P12"' EXIT

[ -f "$P12" ] || { echo "No such file: $P12" >&2; exit 1; }

echo "Repository: $(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo

# -----------------------------------------------------------------------------
# The .p12 and its password.
# -----------------------------------------------------------------------------
# `base64 -i` on macOS emits no trailing newline, which matters: electron-builder
# decodes CSC_LINK directly and a stray newline yields an invalid archive with a
# confusing error.
base64 -i "$P12" | gh secret set MAC_CERT_P12_BASE64
echo "set MAC_CERT_P12_BASE64"

if [ -n "${PRESET_PW:-}" ]; then
  # Exported from the keychain a moment ago with a generated transport
  # password -- no need to ask for something the user never chose.
  printf '%s' "$PRESET_PW" | gh secret set MAC_CERT_PASSWORD
  unset PRESET_PW EXPORT_PW
else
  read -r -s -p "Password you set when exporting the .p12: " CERT_PW; echo
  printf '%s' "$CERT_PW" | gh secret set MAC_CERT_PASSWORD
  unset CERT_PW
fi
echo "set MAC_CERT_PASSWORD"

# -----------------------------------------------------------------------------
# Notarization credentials: an App Store Connect API key.
# -----------------------------------------------------------------------------
# Chosen over an Apple ID plus app-specific password (electron-builder supports
# either) because this is a standalone credential with its own identity: it can
# be revoked on its own without touching the Apple ID that owns the enrollment,
# and it is not derived from an account password.
#
# Create at appstoreconnect.apple.com -> Users and Access -> Integrations ->
# App Store Connect API. The .p8 file downloads exactly ONCE -- Apple will not
# let you download it again, only revoke and reissue.
echo
echo "Notarization uses an App Store Connect API key."
echo "appstoreconnect.apple.com -> Users and Access -> Integrations -> App Store Connect API"
echo

read -r -p "Path to the .p8 key file: " P8_PATH
P8_PATH="${P8_PATH/#\~/$HOME}"
[ -f "$P8_PATH" ] || { echo "No such file: $P8_PATH" >&2; exit 1; }
case "$(head -1 "$P8_PATH")" in
  *"BEGIN PRIVATE KEY"*) ;;
  *)
    echo "That does not look like a .p8 private key." >&2
    echo "The file should start with -----BEGIN PRIVATE KEY-----" >&2
    exit 1
    ;;
esac
gh secret set APPLE_API_KEY_P8 < "$P8_PATH"
echo "set APPLE_API_KEY_P8"

# Apple names the download AuthKey_<KEYID>.p8, so the Key ID can usually be
# read off the filename rather than asked for.
GUESS_ID="$(basename "$P8_PATH" | sed -n 's/^AuthKey_\([A-Z0-9]*\)\.p8$/\1/p')"
if [ -n "$GUESS_ID" ]; then
  read -r -p "Key ID [$GUESS_ID]: " KEY_ID
  KEY_ID="${KEY_ID:-$GUESS_ID}"
else
  read -r -p "Key ID (shown in the App Store Connect key list): " KEY_ID
fi
printf '%s' "$KEY_ID" | gh secret set APPLE_API_KEY_ID
echo "set APPLE_API_KEY_ID"

echo
echo "The Issuer ID is a UUID at the top of the same App Store Connect page."
read -r -p "Issuer ID: " ISSUER
printf '%s' "$ISSUER" | gh secret set APPLE_API_ISSUER
echo "set APPLE_API_ISSUER"

echo
echo "Secrets now on the repository:"
gh secret list

cat <<'NEXT'

Next: cut a release and the workflow signs and notarizes automatically.

    # bump "version" in package.json, commit, then
    git tag v0.1.1 && git push origin v0.1.1

The release run's summary reports whether the built app is ACTUALLY signed --
read off the artifact with codesign, not inferred from these secrets existing.
Notarization adds several minutes; Apple has to answer.

If anything is wrong the macOS build fails rather than silently shipping
unsigned, which is the behaviour you want.
NEXT
