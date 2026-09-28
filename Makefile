SHELL := /usr/bin/env bash

.PHONY: help test test-extensions test-makefile-targets list-extension-targets clean

help: ## Show available Makefile targets
	@grep -E '^[a-zA-Z0-9_.-]+:.*## ' Makefile | sort | awk 'BEGIN {FS = ":.*## "}; {printf "%-24s %s\n", $$1, $$2}'

test: ## Run all repo tests
	node --test tests/*.test.cjs

test-extensions: ## Run extension-focused tests
	node --test tests/makefile_targets.test.cjs tests/headless_output.test.cjs tests/headless_pi.test.cjs tests/wait_for_kubernetes_job.test.cjs

test-makefile-targets: ## Run only the makefile_targets extension tests
	node --test tests/makefile_targets.test.cjs

list-extension-targets: ## Exercise the makefile_targets extension against this Makefile
	@printf '%s\n' 'Call the makefile_targets extension with cwd=/root/.pi/agent'

clean: ## No-op clean target for Makefile parser testing
	@true
