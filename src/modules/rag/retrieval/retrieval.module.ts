import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QdrantModule } from '../../qdrant/qdrant.module';
import { HelpEmbeddingsService } from './embeddings.service';
import { HelpDocsStore } from './help-docs.store';
import { HelpIngestService } from './ingest.service';
import { HelpRetrieveService } from './retrieve.service';

@Module({
  imports: [ConfigModule, QdrantModule],
  providers: [
    HelpEmbeddingsService,
    HelpDocsStore,
    HelpIngestService,
    HelpRetrieveService,
  ],
  exports: [
    HelpRetrieveService,
    HelpIngestService,
    HelpDocsStore,
    // Exported for the category registry, which matches job titles against
    // category descriptions with the same multilingual model. A second embedder
    // would mean a second ~1GB model in memory for identical vectors.
    HelpEmbeddingsService,
  ],
})
export class RetrievalModule {}
