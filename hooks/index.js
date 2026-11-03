// ── MyGate plugin hooks ──────────────────────────────────────────────────
// Loaded automatically by src/index.js before the app starts.
import { addRequestMutation, addResponseMutation } from '../src/gateway/interceptor.js';
import {
    requestMutation as humanCollaboration,
    responseMutation as validateHumanCollaboration,
} from './pi-agent-bridge.js';

addRequestMutation(humanCollaboration);
addResponseMutation(validateHumanCollaboration);

// Optional examples:
// import { addRequestMutation, addResponseMutation } from '../src/gateway/interceptor.js';
// import { requestMutation as multipleRequestMutations } from './request-mutations.example.js';
// import { responseMutation as multipleResponseMutations } from './response-mutations.example.js';
// import { requestMutation as singleRequestMutation } from './request-mutation.example.js';
// import { responseMutation as singleResponseMutation } from './response-mutation.example.js';

// addRequestMutation(multipleRequestMutations);
// addResponseMutation(multipleResponseMutations);
// addRequestMutation(singleRequestMutation);
// addResponseMutation(singleResponseMutation);