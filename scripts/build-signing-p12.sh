#!/usr/bin/env bash
#
# STEP 2 of 2. Turns the certificate Apple issued into the .p12 the release
# workflow needs, and installs it into your keychain for local signing.
#
#     ./scripts/build-signing-p12.sh ~/Downloads/developerID_application.cer
#
# WHY THIS IS NOT JUST `openssl pkcs12 -export`: a bare leaf certificate is not
# enough. Apple's notary service validates the whole chain, so the .p12 has to
# carry the "Developer ID Certification Authority" intermediate as well. The
# Keychain Access route gets this for free because macOS already trusts and
# stores Apple's intermediates; doing it by hand means fetching it explicitly.
# Omitting it produces a signature that looks fine locally and is rejected at
# notarization, which is a slow and confusing way to find out.
set -euo pipefail

CER="${1:-}"
if [ -z "$CER" ] || [ ! -f "$CER" ]; then
  echo "usage: $0 path/to/developerID_application.cer" >&2
  echo >&2
  echo "That is the file downloaded from developer.apple.com after uploading" >&2
  echo "the request made by ./scripts/make-signing-request.sh" >&2
  exit 1
fi

OUT="$HOME/.pagedown-signing"
KEY="$OUT/pagedown-signing.key"
[ -f "$KEY" ] || { echo "No private key at $KEY -- run make-signing-request.sh first." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Apple ships .cer in DER; everything below wants PEM.
openssl x509 -inform DER -in "$CER" -out "$WORK/leaf.pem" 2>/dev/null \
  || openssl x509 -inform PEM -in "$CER" -out "$WORK/leaf.pem"

SUBJECT="$(openssl x509 -in "$WORK/leaf.pem" -noout -subject)"
echo "Certificate: $SUBJECT"
case "$SUBJECT" in
  *"Developer ID Application"*) ;;
  *)
    echo >&2
    echo "WARNING: this does not look like a Developer ID Application certificate." >&2
    echo "Mac App Distribution and Apple Development certificates cannot sign" >&2
    echo "software shipped outside the App Store. Check what you downloaded." >&2
    read -r -p "Continue anyway? [y/N] " ok
    [ "$ok" = "y" ] || exit 1
    ;;
esac

echo "Fetching Apple's Developer ID intermediate..."
curl -fsS https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o "$WORK/inter.cer"
openssl x509 -inform DER -in "$WORK/inter.cer" -out "$WORK/inter.pem"

# Verify the leaf actually chains to that intermediate BEFORE bundling. If it
# does not, the .p12 would be built happily and fail much later, during
# notarization, with a far less obvious message.
if ! openssl verify -partial_chain -trusted "$WORK/inter.pem" "$WORK/leaf.pem" >/dev/null 2>&1; then
  echo >&2
  echo "The certificate does not chain to Apple's Developer ID G2 intermediate." >&2
  echo "If Apple issued yours under a different authority, fetch the matching" >&2
  echo "intermediate from https://www.apple.com/certificateauthority/ and add it." >&2
  exit 1
fi
echo "Chain verified."

P12="$OUT/DeveloperID.p12"
echo
echo "Choose a password for the .p12. You will paste it into the secret-upload"
echo "step, so it does not need to be memorable -- only unguessable."
read -r -s -p "Password: " PW; echo
read -r -s -p "Again:    " PW2; echo
[ "$PW" = "$PW2" ] || { echo "Passwords differ." >&2; exit 1; }
[ -n "$PW" ] || { echo "An empty password will not work with electron-builder." >&2; exit 1; }

openssl pkcs12 -export \
  -inkey "$KEY" \
  -in "$WORK/leaf.pem" \
  -certfile "$WORK/inter.pem" \
  -out "$P12" \
  -passout "pass:$PW" \
  -legacy 2>/dev/null \
  || openssl pkcs12 -export \
       -inkey "$KEY" \
       -in "$WORK/leaf.pem" \
       -certfile "$WORK/inter.pem" \
       -out "$P12" \
       -passout "pass:$PW"

chmod 600 "$P12"
echo "Wrote $P12"

# Install locally too, so `pnpm build:mac` can sign on this machine and so the
# secret-upload script can read the Team ID straight out of the certificate.
if security import "$P12" -k ~/Library/Keychains/login.keychain-db -P "$PW" \
     -T /usr/bin/codesign >/dev/null 2>&1; then
  echo "Imported into your login keychain."
else
  echo "Note: keychain import skipped or already present -- not a problem for CI."
fi
unset PW PW2

echo
echo "Identities now available:"
security find-identity -v -p codesigning | sed 's/^/  /'

cat <<NEXT

NEXT:

  ./scripts/setup-mac-signing.sh "$P12"

That uploads the five secrets. Then bump the version, tag, and the release
signs and notarizes itself.

Keep $KEY and $P12. If you lose the key, the certificate cannot be reissued
against it -- you would revoke and start over.
NEXT
