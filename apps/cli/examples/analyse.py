"""Invoke an installed PlinyCode CLI; PLINY_API_KEY is injected by the caller."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

executable = shutil.which("plinycode.cmd" if os.name == "nt" else "plinycode")
if not executable:
    raise SystemExit("Install PlinyCode and add its directory to PATH.")

launcher = [executable]
if os.name == "nt" and executable.lower().endswith(".cmd"):
    # Avoid cmd.exe interpreting metacharacters in prompts or filenames.
    package = Path(executable).parent
    launcher = [str(package / "runtime" / "bun.exe"), "--use-system-ca", str(package / "plinycode.js")]

command = launcher + [
    "run", "--model", os.environ.get("PLINY_MODEL", "snps-provider-vmodels/glm-5.3"),
    "--prompt", "Analyse the test results. Cite evidence for the judgement.",
    "--output-schema", str(Path(__file__).with_name("judgement.schema.json")), "--json",
]
for filename in sys.argv[1:]:
    command.extend(["--file", filename])
if not sys.argv[1:]:
    raise SystemExit("Usage: python analyse.py test-results.log [metrics.json]")

completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=False)
sys.stderr.write(completed.stderr)
outcome = json.loads(completed.stdout)
print(json.dumps(outcome, indent=2))
raise SystemExit(completed.returncode)
