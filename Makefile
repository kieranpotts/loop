#
# Task runners for this project's development lifecycle.
#

.PHONY: install lint fix typecheck test check help

help:
	@echo "Available targets:"
	@echo "  install    - Install `wish` onto PATH"
	@echo "  lint       - Lint all JavaScript and TypeScript sources with ESLint"
	@echo "  fix        - Auto-fix lint problems with ESLint, then report anything that remains"
	@echo "  typecheck  - Type-check all TypeScript sources with tsc, without emitting output"
	@echo "  test       - Run the test suite with the Node.js built-in test runner"
	@echo "  check      - Run all checks: lint, then type-check, then tests, in sequence"
	@echo "  help       - Show this help message"

install:
	./run/install

lint:
	./run/lint

fix:
	./run/fix

typecheck:
	./run/typecheck

test:
	./run/test

check:
	./run/check
