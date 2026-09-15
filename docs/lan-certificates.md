# Automate production LAN certificates

Use these scripts for [issue #13](https://github.com/lbise/voidstation-app/issues/13):

- `scripts/setup-lan-certificates.sh` is the interactive workflow. Run it on the **Arch laptop**, as your normal user. It creates or renews the certificate, offers local trust installation, transfers the server bundle over SSH, and offers installation on the Ubuntu Server through SSH and sudo.
- `scripts/lan-certificates.py` performs issuance, validation, server installation, and Arch trust installation. It uses Python 3 and OpenSSL, with no Python packages or Node dependencies. It can be copied and run without cloning the application.

The LAN URL remains `https://LAN_IP:3000`. The existing Tailscale hostname keeps its existing certificate. The CA signing key stays encrypted on the laptop and never reaches the Server, desktop, phone, or Docker container.

**Certificate setup does not enable LAN access by itself.** These scripts do not deploy the application, restart containers, alter `.env`, change firewall rules, or enable router forwarding. The [production cutover](deployment.md#persistent-ingress-and-first-cutover) is separate and requires approval.

## 1. Arch laptop: obtain and run the scripts

Choose one Arch computer to hold the signing CA. Use the same computer and state directory for renewal. Do not create a separate CA on the desktop.

Install prerequisites on that laptop if absent:

```sh
sudo pacman -S --needed python openssl openssh p11-kit
```

If you already have the current scripts in a checkout on the laptop, run from that checkout:

```sh
bash scripts/setup-lan-certificates.sh LAN_IP
```

Otherwise copy just the two scripts from the Server. Substitute your SSH login and the checkout path. This works before the code is pushed to GitHub and does not need npm or a build:

```sh
SERVER_LOGIN=owner@server
REMOTE_CHECKOUT=/home/owner/gitrepo/voidstation-app
mkdir -p "$HOME/voidstation-cert-tools/scripts"
scp -o StrictHostKeyChecking=ask -- \
  "$SERVER_LOGIN:$REMOTE_CHECKOUT/scripts/lan-certificates.py" \
  "$SERVER_LOGIN:$REMOTE_CHECKOUT/scripts/setup-lan-certificates.sh" \
  "$HOME/voidstation-cert-tools/scripts/"
bash "$HOME/voidstation-cert-tools/scripts/setup-lan-certificates.sh" LAN_IP
```

Use the Server's reserved LAN IPv4 address for `LAN_IP`, without scheme or port. Verify the Server's SSH host key if prompted. Never disable SSH host-key checking to get the transfer working.

The wizard asks before each change:

1. Create or renew a certificate for that IP. Enter the CA passphrase at the hidden prompt. New CA creation also asks for confirmation of the passphrase.
2. Install the public CA into this Arch laptop's trust store. This may invoke sudo.
3. Transfer the three server files and the installer to the SSH login you enter. Only `cert.pem`, `key.pem`, and `ca.pem` go into the server bundle. The CA signing key is never transferred.
4. Install that bundle on the Ubuntu Server through SSH and sudo. You can decline and run the exact printed command later in a Server terminal.
5. Display the public certificate paths and instructions for the desktop and phone.

A declined step remains listed as pending. The wizard saves the Server command and other-device instructions in `$HOME/.local/share/voidstation-lan-ca/next-steps.txt`, so clearing the terminal does not lose them. If a command fails, the wizard stops rather than continuing to deployment. Review the error and rerun it; it reuses the CA, not a new trust identity.

### Files on the laptop

The default state directory is `$HOME/.local/share/voidstation-lan-ca`, outside the application checkout:

- `ca/` holds the encrypted CA signing key and public CA certificate. Keep this directory private and make an encrypted offline backup. Store its passphrase separately.
- `bundles/` holds versioned server bundles. Each contains the server certificate, its unencrypted server key, and the public CA certificate. Keep these directories owner-only.
- `public/ca.pem` is the public CA for the other Arch computer.
- `public/voidstation-ca.crt` is a DER certificate for Android.
- `public/fingerprint.txt` records the SHA-256 fingerprint printed by the wizard.
- `wizard.env` remembers only non-secret workflow values, not passwords or production application settings.

Never send the entire state directory to another device. Only the public files belong on the desktop and phone. Do not commit any generated certificates, keys, or private setup values.

## 2. Ubuntu Server: install the bundle

If you accepted the wizard's remote-install prompt, it already runs this step on the Server. Do not repeat it merely because you are reading the next section.

If you declined, open a terminal **on the Ubuntu Server** and run the command printed by the wizard. Its paths identify the unique staging directory it just created:

```sh
sudo python3 /home/owner/voidstation-lan-import-ID/lan-certificates.py install \
  --ip LAN_IP --bundle /home/owner/voidstation-lan-import-ID/bundle
```

The installer validates the certificate chain, exact IP, server usage, validity, key pair, and bundle contents before changing the target. By default it installs into `/var/lib/voidstation/lan-tls`. It preserves a previous bundle outside the mounted directory when replacing it. Reinstalling identical files is harmless. An unexpected replacement CA requires explicit acknowledgment; do not use that option for normal renewal.

The final directory is root-owned, group 1000, mode 0750. Public certificates use mode 0644. The server key is UID/GID 1000, mode 0600. No CA signing key enters this directory. Directory replacement keeps the certificate/key pair together; the running container continues using its old mount and certificate until the separately authorized deployment recreates the Dashboard.

Coordinate installation with the deployment window. After trust setup and the initial ingress/configuration work are complete, the owner runs the approved cutover through `./deploy.sh`. For later renewals, normal `./deploy.sh` probes both existing paths and recreates the Dashboard to load the replacement certificate even if the image is unchanged. It does not force an unchanged Assistant worker to restart. Never run a production deployment from a dirty or unreviewed checkout.

Remove the remote staging directory only after successful verification. It contains an unencrypted server key. Keep the installer's previous bundle until rollback is no longer needed, then remove it under the owner's backup-retention policy.

## 3. Arch desktop: trust the same public CA

Copy `public/ca.pem` from the laptop and a copy of `lan-certificates.py` to a private working directory on the **Arch desktop**. Do not copy `ca/` or a server bundle. Compare the fingerprint with the original printed on the laptop, then run as your normal desktop user:

```sh
python3 lan-certificates.py trust-arch --ca ca.pem --fingerprint 'FINGERPRINT_FROM_LAPTOP'
```

The command validates the CA and fingerprint, asks for confirmation, then invokes `sudo trust anchor --store`. It does not silently trust a different certificate. Install the same trust on the laptop this way if you declined that wizard step.

Restart your browsers. Arch's system trust store works for applications using its CA bundle; browser packaging can differ. If Firefox still reports an untrusted issuer, open Settings, Privacy & Security, Certificates, View Certificates, Authorities, then import `ca.pem` and enable trust to identify websites. Do not create a leaf-certificate exception or bypass a warning. Test the actual browser you use.

Removal uses `sudo trust anchor --remove ca.pem`; remove any separately imported Firefox authority too. Keep a public copy of the CA so you can identify it later. See [Arch trust management](https://wiki.archlinux.org/title/Transport_Layer_Security#Trust_management).

## 4. Android phone: approve the CA installation

Copy **only** `public/voidstation-ca.crt` from the laptop to the phone, for example over USB. Search Android Settings for "Install a certificate" or "CA certificate", usually under Security & privacy, More security settings, Encryption & credentials. Choose **CA certificate**, not a VPN/app client certificate. Authenticate with the screen lock, review Android's warning, and select the transferred file.

Android requires you to approve this security change on the device; a laptop script cannot bypass it. Menu names vary by manufacturer and version. Check the installed CA under trusted credentials or user credentials. See [Android's instructions](https://support.google.com/pixelphone/answer/2844832).

Use a browser that honors Android's user-installed CA store. Managed-device policy or a browser's own store may prevent that. If it still shows a certificate warning, stop and resolve trust rather than continuing through it. Native Android apps do not all trust user-added CAs; this setup is for browser access.

After the separately approved deployment, disable Tailscale on the phone and open `https://LAN_IP:3000`. Verify no warning, then log in, open the Dashboard, and check saved Assistant history. Repeat on Arch. Certificate generation and Server-local validation do not prove trust or reachability from those physical clients.

## Renewal and recovery

The server certificate lasts one year. Set a reminder for 60 days before expiry; preflight refuses a leaf within 30 days of expiry. The CA lasts ten years. Before the earlier expiry, rerun the wizard **on the same Arch laptop**, using the same state directory and IP. It unlocks the existing CA, creates a new server key and certificate, and offers transfer/installation again. Existing clients need no new trust installation because the CA is unchanged.

If the CA is missing, corrupt, expired, or has the wrong password, the script fails rather than silently creating a replacement identity. Restore its encrypted backup or plan a CA rotation with trust changes on every device. Protecting the signing key matters: anyone with that key and passphrase can issue certificates your devices trust.

If the server certificate has already expired, ordinary before-update probes fail. Install a valid replacement and follow the runbook's approved saved-image recovery procedure to recreate the service. Do not disable certificate verification. If the CA is compromised, remove its trust from every device, replace both CA and leaf, and rotate the owner password if interception is possible. There is no automatic revocation-distribution service.

## Non-interactive building blocks

Run `python3 scripts/lan-certificates.py --help` for command arguments. `issue` and `verify` can run on the laptop; `install` belongs on the Server with sudo; `trust-arch` belongs on each Arch client. Advanced automation may supply a CA passphrase through an inherited file descriptor, never an argument, environment variable, or plaintext passphrase file. The wizard uses the terminal's hidden prompt instead.

Automated tests use disposable certificates and mocked trust/SSH commands. They do not provision the production CA, install device trust, or perform a live cutover.
