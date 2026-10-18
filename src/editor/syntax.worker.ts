import { analyzeSyntaxRequest } from './syntaxAnalysisWorker.ts';
import type { SyntaxAnalysisRequest } from './syntaxAnalysisProtocol.ts';

self.onmessage = (event: MessageEvent<SyntaxAnalysisRequest>) => {
  self.postMessage(analyzeSyntaxRequest(event.data));
};
