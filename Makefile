PYTHON ?= python3
PY_SOURCES = services scripts guest tests
SHELL_SOURCES = scripts/*.sh guest/*.sh guest/cell-run

.PHONY: help check lint test desktop format package verify-vm
help:
	@echo 'make check      Offline syntax, lint, formatting and unit tests (no VM/account access)'
	@echo 'make lint       Ruff, shellcheck (when installed) and Prettier checks only'
	@echo 'make test       Python services, Pi protocol and desktop unit tests'
	@echo 'make desktop    Start the desktop application from source'
	@echo 'make format     Format Python (ruff), desktop and Pi sources (prettier)'
	@echo 'make package    Build unsigned macOS arm64 application'
	@echo 'make verify-vm  Explicit live isolation verification against secure-vm'

check: lint
	$(PYTHON) scripts/check-source.py
	npm --prefix desktop run check
	node --test pi/tests/*.test.mjs
	$(PYTHON) -m unittest discover -s tests -q

lint:
	$(PYTHON) -m ruff check $(PY_SOURCES)
	$(PYTHON) -m ruff format --check $(PY_SOURCES)
	@if command -v shellcheck >/dev/null 2>&1; then shellcheck -S warning -x $(SHELL_SOURCES); \
	else echo 'shellcheck not installed; skipped locally (CI runs it)'; fi

test:
	npm --prefix desktop test
	node --test pi/tests/*.test.mjs
	$(PYTHON) -m unittest discover -s tests -q

desktop:
	npm --prefix desktop start

format:
	$(PYTHON) -m ruff check --fix $(PY_SOURCES)
	$(PYTHON) -m ruff format $(PY_SOURCES)
	npm --prefix desktop run format

package: check
	npm --prefix desktop run package

verify-vm:
	bash scripts/verify.sh
