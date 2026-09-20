PYTHON ?= python3

.PHONY: help check test desktop format package verify-vm
help:
	@echo 'make check      Offline syntax, formatting and unit tests (no VM/account access)'
	@echo 'make test       Python services, Pi protocol and desktop unit tests'
	@echo 'make desktop    Start the desktop application from source'
	@echo 'make format     Format desktop source and tests'
	@echo 'make package    Build unsigned macOS arm64 application'
	@echo 'make verify-vm  Explicit live isolation verification against secure-vm'

check:
	$(PYTHON) scripts/check-source.py
	npm --prefix desktop run check
	node --test pi/tests/*.test.mjs
	$(PYTHON) -m unittest discover -s tests -q

test:
	npm --prefix desktop test
	node --test pi/tests/*.test.mjs
	$(PYTHON) -m unittest discover -s tests -q

desktop:
	npm --prefix desktop start

format:
	npm --prefix desktop run format

package: check
	npm --prefix desktop run package

verify-vm:
	bash scripts/verify.sh
