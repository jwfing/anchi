PYTHON ?= python3
VM ?= anchi-vm
# Guest root: through Lima, or sudo on a remote server where Anchi runs in the guest (ANCHI_GUEST=local).
GUEST_ROOT = $(if $(filter local,$(ANCHI_GUEST)),sudo -n,limactl shell $(VM) -- sudo)
PY_SOURCES = services scripts guest tests
SHELL_SOURCES = scripts/*.sh guest/*.sh guest/cell-run landing/dist/install.sh

.PHONY: help check lint test format verify-vm verify-anchi
help:
	@echo 'make check         Offline syntax, lint, formatting and unit tests (no VM/account access)'
	@echo 'make lint          Ruff, shellcheck (when installed) and Prettier checks only'
	@echo 'make test          Python services and anchi unit tests'
	@echo 'make format        Format Python (ruff) and anchi sources (prettier)'
	@echo 'make verify-vm     Explicit live isolation verification against anchi-vm'
	@echo 'make verify-anchi  Live agent-team cell and egress proxy checks (no credentials used)'

check: lint
	$(PYTHON) scripts/check-source.py
	pnpm --dir anchi run check
	$(PYTHON) scripts/gen-skill-cli.py --check
	$(PYTHON) -m unittest discover -s tests -q

lint:
	$(PYTHON) -m ruff check $(PY_SOURCES)
	$(PYTHON) -m ruff format --check $(PY_SOURCES)
	@if command -v shellcheck >/dev/null 2>&1; then shellcheck -S warning -x $(SHELL_SOURCES); \
	else echo 'shellcheck not installed; skipped locally (CI runs it)'; fi

test:
	pnpm --dir anchi test
	$(PYTHON) -m unittest discover -s tests -q

format:
	$(PYTHON) -m ruff check --fix $(PY_SOURCES)
	$(PYTHON) -m ruff format $(PY_SOURCES)
	pnpm --dir anchi run format

verify-vm:
	bash scripts/verify.sh

verify-anchi:
	$(GUEST_ROOT) /usr/bin/python3 /opt/secure-vm/check-anchi.py $(START_BUDGET_MS)
