PYTHON ?= python3
PY_SOURCES = services scripts guest tests
SHELL_SOURCES = scripts/*.sh guest/*.sh guest/cell-run

.PHONY: help check lint test format verify-vm verify-anchi
help:
	@echo 'make check         Offline syntax, lint, formatting and unit tests (no VM/account access)'
	@echo 'make lint          Ruff, shellcheck (when installed) and Prettier checks only'
	@echo 'make test          Python services and anchi unit tests'
	@echo 'make format        Format Python (ruff) and anchi sources (prettier)'
	@echo 'make verify-vm     Explicit live isolation verification against secure-vm'
	@echo 'make verify-anchi  Live agent-team cell and egress proxy checks (no credentials used)'

check: lint
	$(PYTHON) scripts/check-source.py
	pnpm --dir anchi run check
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
	limactl shell secure-vm -- sudo /usr/bin/python3 /opt/secure-vm/check-anchi.py
