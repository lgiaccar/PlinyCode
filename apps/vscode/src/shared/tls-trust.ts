/**
 * Extra TLS trust for requests whose certificate chain Node cannot verify on
 * its own.
 *
 * The Pliny gateway serves only its leaf certificate, without the SNPSica2
 * intermediate. Windows fetches missing intermediates itself (AIA), but Node
 * verifies against its bundled roots only, so plain `fetch` fails with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE. VS Code usually hides this by injecting the
 * OS store into the extension host; Cursor builds and machines without the
 * intermediate cached do not, and every Pliny request then fails.
 *
 * `trustedCaCertificates()` returns Node's roots, the OS store where this Node
 * can read it, and the public Synopsys CA certificates below. It adds trust; it
 * never turns verification off.
 */

import tls from "node:tls"

/** Synopsys issuing CA (CN=SNPSica2), signed by SNPSOfflineCA. Expires 2035-06-19. */
const SNPS_ICA2_PEM = `
-----BEGIN CERTIFICATE-----
MIIGlDCCBXygAwIBAgITRAAAAB3vzb+3f3p7RwABAAAAHTANBgkqhkiG9w0BAQsFADAYMRYwFAYD
VQQDEw1TTlBTT2ZmbGluZUNBMB4XDTI1MDYxODIzNTIzM1oXDTM1MDYxOTAwMDIzM1owXDETMBEG
CgmSJomT8ixkARkWA2NvbTEYMBYGCgmSJomT8ixkARkWCHN5bm9wc3lzMRgwFgYKCZImiZPyLGQB
GRYIaW50ZXJuYWwxETAPBgNVBAMTCFNOUFNpY2EyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEAzXFEI177QoLMWlHAKnKgq2pbKtIsHBHN9LR3TWFgGy0tlgllgae0BVPZYyE9+Gjci1A6
BH4gq4rjD701K1y8YNBIpXB0SjaYL1c5qO14lwD3MYMRHmUPtgHXdBrwvJsyFmGiLJCwihBnxvOb
OhMUPGST+fc8dX/mAtd6JOUVLhDyFoRCYpplKXb5AZc+nxMKEi0C0N9bQ7Dbnzq58JaN+Qo0ZZNN
mp9baMuNL8aW7vsxUw1jlSBsYM6zEFcj3Pfn3Ay7w8MGrGm1wVdB1iHsevWEXOT0WYjtynGbc44A
46KoVFZYGKUI9fAJITgT4jDAnk5SoqVw/qEMwU+DkHlwmQIDAQABo4IDkTCCA40wEgYJKwYBBAGC
NxUBBAUCAwIAAjAjBgkrBgEEAYI3FQIEFgQU8D/2QXclxY6SFpOV15C30DSJoN0wHQYDVR0OBBYE
FDLERuoKzsc36w3sjio/BBBHAU/gMIGEBgNVHSAEfTB7MHkGCCoDBIsvQ1kFMG0wOgYIKwYBBQUH
AgIwLh4sAEwAZQBnAGEAbAAgAFAAbwBsAGkAYwB5ACAAUwB0AGEAdABlAG0AZQBuAHQwLwYIKwYB
BQUHAgEWI2h0dHA6Ly93d3cuY29udG9zby5jb20vcGtpL2Nwcy50eHQAMBkGCSsGAQQBgjcUAgQM
HgoAUwB1AGIAQwBBMAsGA1UdDwQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFA5M
7QXFipEAecI3OOwm/fBEZqyKMIIBIgYDVR0fBIIBGTCCARUwggERoIIBDaCCAQmGgcNsZGFwOi8v
L0NOPVNOUFNPZmZsaW5lQ0EsQ049VVMwMlZXT0ZGTElORUNBLENOPUNEUCxDTj1QdWJsaWMlMjBL
ZXklMjBTZXJ2aWNlcyxDTj1TZXJ2aWNlcyxDTj1Db25maWd1cmF0aW9uLERDPXN5bm9wc3lzZm9y
ZXN0LERDPWNvbT9jZXJ0aWZpY2F0ZVJldm9jYXRpb25MaXN0P2Jhc2U/b2JqZWN0Q2xhc3M9Y1JM
RGlzdHJpYnV0aW9uUG9pbnSGQWh0dHA6Ly91czAyY3JsLmludGVybmFsLnN5bm9wc3lzLmNvbS9D
ZXJ0RW5yb2xsL1NOUFNPZmZsaW5lQ0EuY3JsMIIBKgYIKwYBBQUHAQEEggEcMIIBGDCBswYIKwYB
BQUHMAKGgaZsZGFwOi8vL0NOPVNOUFNPZmZsaW5lQ0EsQ049QUlBLENOPVB1YmxpYyUyMEtleSUy
MFNlcnZpY2VzLENOPVNlcnZpY2VzLENOPUNvbmZpZ3VyYXRpb24sREM9c3lub3BzeXNmb3Jlc3Qs
REM9Y29tP2NBQ2VydGlmaWNhdGU/YmFzZT9vYmplY3RDbGFzcz1jZXJ0aWZpY2F0aW9uQXV0aG9y
aXR5MGAGCCsGAQUFBzAChlRodHRwOi8vdXMwMmNybC5pbnRlcm5hbC5zeW5vcHN5cy5jb20vQ2Vy
dEVucm9sbC9VUzAyVldPRkZMSU5FQ0FfU05QU09mZmxpbmVDQSgxKS5jcnQwDQYJKoZIhvcNAQEL
BQADggEBAHhKV0AAfokSkh6dZfj14nG/DPP1fPmiH7kvXiA0IiORmq0T0oZdZ1fWirwlHjRwNiC0
4+7ULEKS9xjJOA2Ed+HvXyBBLBSHsc4bnTyUaihaR3E8JWeio8GgsDZEhOeqDggA6PMyJp64SJ8l
pxL0CkeeE6NnzZ5//QEir77XGb9xhWZ464yRuKsp1iQpe7/7+fyk08oza/wZIo7eqxy+1zd7nqZs
ycJvSFaMCE+k1F2+XP6yedQCx9oZdAZ3oPJz2vMCLnBHVch2uQ8xw2axHpSlvekmFo2RiBX7/gA/
O+etchGu6VSYvZ4Y4FrPZet2dDZH1d2aGquASk0cPOvCXOQ=
-----END CERTIFICATE-----
`

/** Synopsys root CA (CN=SNPSOfflineCA), self-signed. Expires 2036-04-29. */
const SNPS_OFFLINE_CA_PEM = `
-----BEGIN CERTIFICATE-----
MIIDuTCCAqGgAwIBAgIQTLdoti3FZqFGpNBB7B8i7zANBgkqhkiG9w0BAQsFADAYMRYwFAYDVQQD
Ew1TTlBTT2ZmbGluZUNBMB4XDTEzMDkwNDA5MjIwMFoXDTM2MDQyOTAxMDU1NlowGDEWMBQGA1UE
AxMNU05QU09mZmxpbmVDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALN5j5EqTSlp
tnnD8s9vQioyJdWULz0menTJf9/O5BfXhUbaC/7x6w5Q9vSeQ42b93GUSSfitOBF3Ry7lGE+phrz
niKt08VL3isJC2xQ6Uyd7oND5BKmpfP7qXjc4rvoSgswx0ggV8xF+IrZzpnh1LTW6AzwJflZFphE
0zIYDtm8Ux/cvmrOADidOhQTHsWOSLvzIVGeyPVA0Kj+quA1nEC5xhybX2PBgiBCtjRATbJBbDcz
BahGr3O+2RBbiNTaOSJmnpHefyfrhjEW8Y7lm1ZfRSmGuomqnd96ojEIoQp8ISudykCPoxSPX7t0
NMg7FqPwRnrgQiwEnL/3S4/8X3kCAwEAAaOB/jCB+zALBgNVHQ8EBAMCAYYwDwYDVR0TAQH/BAUw
AwEB/zAdBgNVHQ4EFgQUDkztBcWKkQB5wjc47Cb98ERmrIowEAYJKwYBBAGCNxUBBAMCAQEwgYQG
A1UdIAR9MHsweQYIKgMEiy9DWQUwbTA6BggrBgEFBQcCAjAuHiwATABlAGcAYQBsACAAUABvAGwA
aQBjAHkAIABTAHQAYQB0AGUAbQBlAG4AdDAvBggrBgEFBQcCARYjaHR0cDovL3d3dy5jb250b3Nv
LmNvbS9wa2kvY3BzLnR4dAAwIwYJKwYBBAGCNxUCBBYEFIb4Po8GCCt3uxkCf9uN4QMt9Kq6MA0G
CSqGSIb3DQEBCwUAA4IBAQBYx6XcnQUHRIFOtMBJ6elQ3jXH8U0YBAFSxHxB7sW351k9zt04xR8a
jK6i0Xw+K2paEmd7zWcdbbOxeO2ZTCWwTYNCWdEggFs9w4pKa8IfiKNRjVBb4Dv4SqfM55h8vqUz
+63gsS55jLVHburOowJcSkAJVua2UHOkZMAo7zJU28FhKffIN4qfdbGLeGcbsm6NrBZ3AT/IYOUx
KV6cVmJuiRAOz3KudZpVFtjYczNkVnVmTKVyGSdg68lJL3pNJCUd3Gp14c94Az5lIguCgkA9yjcF
4fH56zFlEQxD7RfW1XJEq5kbYmX2PfpO7doaMs+r3LeSnNJWSGv6YBVRDWSd
-----END CERTIFICATE-----
`

export const SYNOPSYS_CA_CERTIFICATES: readonly string[] = [SNPS_ICA2_PEM.trim(), SNPS_OFFLINE_CA_PEM.trim()]

/** OpenSSL verification codes that mean "chain not trusted", as opposed to expired, revoked or wrong host. */
const TLS_TRUST_ERROR_CODES = new Set([
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"CERT_UNTRUSTED",
])

/** True when `error`, or any error in its `cause` chain, is a certificate trust failure. */
export function isTlsTrustError(error: unknown): boolean {
	let current: unknown = error
	for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
		const code = (current as { code?: unknown }).code
		if (typeof code === "string" && TLS_TRUST_ERROR_CODES.has(code)) {
			return true
		}
		current = (current as { cause?: unknown }).cause
	}
	return false
}

function systemCaCertificates(): string[] {
	// tls.getCACertificates exists from Node 22.15 / 23.10; older editor hosts lack it.
	const getCACertificates = (tls as { getCACertificates?: (type: "system") => string[] }).getCACertificates
	if (typeof getCACertificates !== "function") {
		return []
	}
	try {
		return getCACertificates("system")
	} catch {
		return []
	}
}

let cachedBundle: string[] | undefined

/** Node's roots + the OS store (when readable) + the Synopsys CAs, deduplicated. */
export function trustedCaCertificates(): string[] {
	cachedBundle ??= [...new Set([...tls.rootCertificates, ...systemCaCertificates(), ...SYNOPSYS_CA_CERTIFICATES])]
	return cachedBundle
}
