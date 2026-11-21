"""Validate the downloaded archive checksum before extracting it for portable E2E."""
import hashlib
from pathlib import Path
import tarfile
import zipfile

archives = list(Path('.').glob('PlinyCode-CLI-*.zip')) + list(Path('.').glob('PlinyCode-CLI-*.tar.gz'))
if len(archives) != 1:
    raise RuntimeError('Expected exactly one CLI release archive')
archive = archives[0]
expected = Path(str(archive) + '.sha256').read_text().strip()
actual = f'{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}'
if actual != expected:
    raise RuntimeError('CLI archive checksum mismatch; refusing extraction')
if archive.suffix == '.zip':
    with zipfile.ZipFile(archive) as package:
        package.extractall('.')
else:
    with tarfile.open(archive) as package:
        package.extractall('.', filter='data')
print(f'Verified and extracted {archive.name}')
