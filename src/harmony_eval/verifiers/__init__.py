"""Discover built-in verifier modules when the registry is first used."""

import importlib
import pkgutil


for module in pkgutil.iter_modules(__path__):
    if module.name.endswith("_verifier"):
        importlib.import_module(f"{__name__}.{module.name}")
