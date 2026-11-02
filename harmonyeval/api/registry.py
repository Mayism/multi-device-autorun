"""Builtin and entry-point registries for independently extensible adapters."""

from importlib import metadata


class Registry:
    def __init__(self, group):
        self.group, self.items, self.loaded = group, {}, False

    def register(self, name):
        def decorate(cls):
            if name in self.items:
                raise ValueError(f"重复适配器: {self.group}/{name}")
            self.items[name] = cls
            return cls
        return decorate

    def get(self, name):
        if self.group in ('datasets', 'targets', 'execution', 'verification', 'scoring'):
            from harmonyeval.api.builtins import register_builtins
            register_builtins()
        if not self.loaded:
            self.loaded = True
            installed = metadata.entry_points()
            for prefix in ('harmonyeval', 'harmony_eval'):
                for entry in installed.select(group=f"{prefix}.{self.group}"):
                    implementation = entry.load()
                    if self.items.get(entry.name) is not implementation:
                        self.register(entry.name)(implementation)
        if name not in self.items:
            raise ValueError(f"未知 {self.group} 适配器 {name!r}；可选: {', '.join(self.items)}")
        return self.items[name]

    def validate(self, name, config):
        cls = self.get(name)
        schema = getattr(cls, "schema", None)
        if schema:
            from jsonschema import validate
            validate(config, schema)
        validate_config = getattr(cls, "validate", None)
        if validate_config:
            validate_config(config)
        return cls


datasets = Registry("datasets")


targets = Registry("targets")


executors = Registry("execution")


verifiers = Registry("verification")


scorers = Registry("scoring")
