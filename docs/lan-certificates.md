# Production LAN certificates

Issue [#13](https://github.com/lbise/voidstation-app/issues/13) uses the Server's reserved private IPv4 address on HTTPS port 3000. The owner chose a dedicated private CA and manual trust installation on Arch Linux and Android. No router DNS override or DDNS is needed. Keep the existing Tailscale hostname and its Tailscale-issued certificate for remote access.

The LAN URL is `https://LAN_IP:3000`. Replace `LAN_IP` with the reserved Server address in the private `.env`. Do not use the Tailscale certificate for that URL: it covers a DNS name, not the LAN IP. Both listeners run the same application and use the same owner database and conversation storage.

These instructions describe owner-run provisioning. Repository implementation does not authorize creating a CA, installing device trust, replacing production certificates, or restarting containers. Agree the installation and cutover window first.

## Issue a dedicated CA and server certificate

Run this on an owner-controlled Arch workstation, not in the repository, development certificate directory, or application container. OpenSSL prompts for the CA key's encryption passphrase. Store that passphrase separately. The CA private key can issue certificates trusted by your devices; never copy it to the Server, commit it, or mount it in Docker.

```sh
umask 077
mkdir -m 700 "$HOME/voidstation-ca"
cd "$HOME/voidstation-ca"
# Set this to the Server's reserved LAN IPv4 address.
read -r -p 'Server LAN IPv4 address: ' LAN_IP
python3 -c 'import ipaddress,sys; a=ipaddress.IPv4Address(sys.argv[1]); assert any(a in ipaddress.ip_network(n) for n in ["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"])' "$LAN_IP"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc -out ca-key.pem
openssl req -new -x509 -sha256 -days 3650 -key ca-key.pem -out ca.pem \
  -subj '/CN=Voidstation production LAN CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out key.pem
openssl req -new -key key.pem -out server.csr -subj '/CN=Voidstation LAN'
printf '%s\n' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' \
  "subjectAltName=IP:$LAN_IP" > server.ext
openssl x509 -req -sha256 -days 365 -in server.csr \
  -CA ca.pem -CAkey ca-key.pem -CAcreateserial -extfile server.ext -out cert.pem
openssl verify -CAfile ca.pem -purpose sslserver -verify_ip "$LAN_IP" cert.pem
openssl x509 -in cert.pem -noout -checkend 2592000
openssl x509 -in ca.pem -noout -fingerprint -sha256
```

Save the CA fingerprint through a trusted channel before copying its public certificate to another device. Keep an encrypted offline backup of the CA directory, including the signing key and serial file. Do not put the CA passphrase in shell arguments or environment variables. The server key is deliberately unencrypted so the unprivileged service can start unattended; protect it with filesystem permissions.

Transfer only `cert.pem`, `key.pem`, and `ca.pem` to an owner-only staging directory on the Server over authenticated SSH. Verify the SSH host key. Never transfer `ca-key.pem`. Verify the certificate again on the Server with the commands above, and compare public keys before installing:

```sh
openssl x509 -in cert.pem -noout -pubkey > certificate-public.pem
openssl pkey -in key.pem -pubout > key-public.pem
cmp certificate-public.pem key-public.pem
```

After owner approval, install into the dedicated directory configured as `VOIDSTATION_LAN_TLS_DIRECTORY`. The following uses its documented default. Refuse symlinks or unexpectedly owned parent directories; do not repurpose another application's directory.

```sh
sudo install -d -o root -g 1000 -m 0750 /var/lib/voidstation/lan-tls
sudo install -o root -g 1000 -m 0644 cert.pem ca.pem /var/lib/voidstation/lan-tls/
sudo install -o 1000 -g 1000 -m 0600 key.pem /var/lib/voidstation/lan-tls/
```

The directory contains only these three files. Production mounts it read-only. Certificate installation does not authorize a restart. Coordinate installation with the deployment window so no process starts while the certificate/key pair is being replaced. Keep the prior valid pair in an owner-only directory outside the mount until verification passes. Remove staging copies of the unencrypted server key afterward.

## Trust on Arch Linux

Perform this on both the laptop and desktop. Copy only the public `ca.pem` and compare its SHA-256 fingerprint with the workstation's original. A PEM CA certificate is a public trust anchor, not a private key.

```sh
openssl x509 -in ca.pem -noout -fingerprint -sha256
sudo trust anchor --store ca.pem
```

Restart the browser. Arch's system trust store supports applications using the system CA bundle. Browser trust handling varies by browser and packaging. If Firefox does not use that store, open Settings, Privacy & Security, Certificates, View Certificates, Authorities, then import `ca.pem` and enable trust to identify websites. Do not add a permanent exception for the server leaf certificate. Test the actual browser you use rather than assuming the system installation covers it.

Removal uses `sudo trust anchor --remove ca.pem`; remove any separately imported browser authority too. Keep a copy of the public CA certificate so you can identify and remove it later. See [Arch's certificate authority documentation](https://wiki.archlinux.org/title/Transport_Layer_Security#Trust_management).

## Trust on Android

Transfer only `ca.pem` to the phone through an owner-controlled channel. If the file picker does not recognize PEM, convert it on the workstation with `openssl x509 -in ca.pem -outform DER -out voidstation-ca.crt` and transfer that public file instead.

Android menu names vary by manufacturer and version. Search Settings for "Install a certificate" or "CA certificate", usually under Security & privacy, More security settings, Encryption & credentials. Choose **CA certificate**, not a VPN/app client certificate. Authenticate with the phone's screen lock, review Android's warning, and install the verified CA. Check the installed CA under trusted credentials or user credentials. This grants trust to certificates signed by this CA; it is not a certificate-warning bypass.

Use a browser that honors Android's user-installed CA store and test the actual browser. Managed-device policy or a browser's independent store may prevent this. If it still reports an untrusted certificate, stop and resolve the trust configuration; do not continue through the warning. Android apps do not all trust user-added CAs, so this setup promises browser access, not access from every native app. See [Android's certificate installation instructions](https://support.google.com/pixelphone/answer/2844832).

After the separately authorized deployment, disable Tailscale on the phone and browse to `https://LAN_IP:3000`. Confirm there is no warning, then log in and open the Dashboard and Assistant history. Repeat on Arch. Record the browser, OS, date, and result without passwords or cookies. Trust setup and physical-device checks remain unperformed until the owner completes them.

## Renewal and loss

The CA lasts ten years; the server certificate lasts one year. Set an owner calendar reminder for 60 days before the earlier expiry. Preflight refuses a LAN certificate within 30 days of expiry. There is no unattended LAN signing service, and the CA private key remains offline.

For renewal, keep the same CA and LAN IP, generate a new server key and CSR in a new owner-only directory, and sign using the existing CA key and serial file. Repeat the verification and approved installation steps, then update through `./deploy.sh` during the agreed window. Keep the CA certificate unchanged so clients need no new trust installation. Verify both HTTPS paths after deployment. A certificate file change alone does not reload the application.

If the certificate has already expired, normal updates fail their before-deployment HTTPS checks. After installing a valid replacement, use the runbook's separately authorized saved-image recovery procedure to recreate the service and reload the certificate. Do not disable TLS verification or skip the Tailscale pre-cutover check. If the CA expires or its private key is lost, issue a replacement CA and reinstall trust on each device before cutover. If the CA key is compromised, remove its trust from every device promptly, replace the CA and leaf certificate, and rotate the owner password if credential interception is possible. There is no automatic revocation-distribution service.
