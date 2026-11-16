PYTHON ?= python3
PY_SOURCES = services scripts guest tests
SHELL_SOURCES = scripts/*.sh guest/*.sh guest/cell-run landing/dist/install.sh

.PHONY: help check lint test format verify-guest verify-anchi
help:
	@echo 'make check         Offline syntax, lint, formatting and unit tests (no guest/account access)'
	@echo 'make lint          Ruff, shellcheck (when installed) and Prettier checks only'
	@echo 'make test          Python services and anchi unit tests'
	@echo 'make format        Format Python (ruff) and anchi sources (prettier)'
	@echo 'make verify-guest  Explicit live isolation verification on a remote server (ANCHI_GUEST=local)'
	@echo 'make verify-anchi  Live agent-team cell and egress proxy checks on a remote server (no credentials used)'

check: lint
	$(PYTHON) scripts/check-source.py
	pnpm --dir anchi run check
	$(PYTHON) scripts/gen-skill-cli.py --check
	$(PYTHON) scripts/gen-egress-fixtures.py --check
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

# Both run on the guest itself: a remote server where Anchi runs with ANCHI_GUEST=local.
verify-guest:
	bash scripts/verify.sh

verify-anchi:
	sudo -n /usr/bin/python3 /opt/secure-vm/check-anchi.py $(START_BUDGET_MS)
