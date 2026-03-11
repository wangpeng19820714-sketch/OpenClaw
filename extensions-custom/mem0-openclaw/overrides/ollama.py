from typing import Literal, Optional

from mem0.configs.embeddings.base import BaseEmbedderConfig
from mem0.embeddings.base import EmbeddingBase
from ollama import Client


class OllamaEmbedding(EmbeddingBase):
    def __init__(self, config: Optional[BaseEmbedderConfig] = None):
        super().__init__(config)

        self.config.model = self.config.model or "nomic-embed-text"
        self.config.embedding_dims = self.config.embedding_dims or 512

        self.client = Client(host=self.config.ollama_base_url)
        self._ensure_model_exists()

    def _ensure_model_exists(self):
        local_models = self.client.list()["models"]
        if not any(model.get("name") == self.config.model or model.get("model") == self.config.model for model in local_models):
            self.client.pull(self.config.model)

    def embed(self, text, memory_action: Optional[Literal["add", "search", "update"]] = None):
        # Upstream still calls the deprecated `embeddings(prompt=...)` path, but the
        # current Ollama client expects `embed(input=...)` for batch-safe requests.
        response = self.client.embed(model=self.config.model, input=text)
        embeddings = response["embeddings"]

        if isinstance(text, str):
            return embeddings[0]

        return embeddings
