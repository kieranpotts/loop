.DEFAULT_GOAL := help

install: ## Install `wish` onto PATH
	./run/install

lint: ## Lint all JavaScript and TypeScript sources with ESLint
	./run/lint

fix: ## Auto-fix lint problems with ESLint, then report anything that remains
	./run/fix

typecheck: ## Type-check all TypeScript sources with tsc, without emitting output
	./run/typecheck

test: ## Run the test suite with the Node.js built-in test runner
	./run/test

check: ## Run all checks: lint, then type-check, then tests, in sequence
	./run/check

help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.PHONY: install lint fix typecheck test check help
