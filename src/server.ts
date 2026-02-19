#!/usr/bin/env node

import {
    createConnection,
    ProposedFeatures,
    TextDocuments,
    TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(
    ProposedFeatures.all,
    process.stdin,
    process.stdout,
);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize(() => {
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // TODO
        },
    };
});

documents.listen(connection);
connection.listen();

console.error('PHPStan LS Lite started!');
