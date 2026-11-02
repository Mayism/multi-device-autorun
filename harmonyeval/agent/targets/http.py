"""Describe remote HTTP agent targets."""

from harmonyeval.api.registry import targets


@targets.register("knowledge")
@targets.register("http_agent")
class HttpTarget:
    version = "1"
    engine = "http"

    def source(self, task):
        return {"engine": "http", "url": task["active"]["execution"]["http_url"]}

    def prepare(self, task, runtime):
        return {"manifest": self.source(task)}
