/**
 * @file
 * Contains the validator class.
 */

const debounce = require('lodash.debounce');
const { reportFlatten } = require('./phpcs-report');
const { createRunner } = require('./runner');
const { createTokenManager } = require('./tokens');

/**
 * Validator runtime object.
 *
 * @typedef {object} ValidatorRuntime
 *
 * @property {() => void} dispose
 *   Dispose the current validator listener.
 * @property {function(typeof import('vscode').workspace): void} setFromConfig
 *   VSCode editor workspace namespace API.
 * @property {function(import('vscode').TextDocument): void} validate
 *   Validates a text document.
 */

/**
 * Resets validator for new settings.
 *
 * @param {import('vscode').DiagnosticCollection} diagnostics
 *   Diagnostic collection.
 * @param {import('./tokens').TokenManager} tokenManager
 *   Token manager.
 * @param {typeof import('vscode').workspace} workspace
 *   VSCode editor workspace namespace API.
 * @param {ValidatorRuntime} validatorRuntime
 *   Text document validator runtime manager.
 */
function reset(diagnostics, tokenManager, workspace, validatorRuntime) {
  diagnostics.clear();
  tokenManager.clearTokens();
  validatorRuntime.setFromConfig(workspace);

  workspace.textDocuments.forEach(validatorRuntime.validate);
}

/**
 * Constructs a validator runtime object.
 *
 * @param {function(import('vscode').TextDocument): void} validate
 *   Text document validator.
 *
 * @return {ValidatorRuntime}
 *   The validator runtime.
 */
const createValidatorRuntime = (validate) => ({
  dispose() {
  },
  setFromConfig(workspace) {
    this.dispose();

    const config = workspace.getConfiguration('phpSniffer');

    const disposable = config.get('run', 'onSave') === 'onSave'
      ? workspace.onDidSaveTextDocument(validate)
      : workspace.onDidChangeTextDocument(
        debounce(({ document }) => { validate(document); }, config.get('onTypeDelay', 250)),
      );
    this.dispose = disposable.dispose.bind(disposable);
  },
  validate,
});

/**
 * Calls the given callback if the passed even affects validator running.
 *
 * @param {Function} callback
 *   The callback to run.
 *
 * @return {function(import('vscode').ConfigurationChangeEvent): void}
 *   The function to attached to workspace.onDidChangeConfiguration().
 */
const isRunAffect = (callback) => (event) => {
  if (
    !event.affectsConfiguration('phpSniffer')
    || !(event.affectsConfiguration('phpSniffer.run') || event.affectsConfiguration('phpSniffer.onTypeDelay'))
  ) {
    return;
  }

  callback();
};

/**
 * Removes a text document from diagnostics and tokens.
 *
 * @param {import('vscode').DiagnosticCollection} diagnostics
 *   Diagnostic collection.
 * @param {import('./tokens').TokenManager} tokenManager
 *   Token manager.
 *
 * @return {function(import('vscode').TextDocument): void} document
 *   The text document.
 */
const onDocumentClose = (diagnostics, tokenManager) => ({ uri }) => {
  diagnostics.delete(uri);
  tokenManager.discardToken(uri.fsPath);
};

/**
 * Lints a document.
 *
 * @param {typeof import('vscode').window} window
 *   The VSCode window.
 * @param {typeof import('vscode').workspace} workspace
 *   VSCode workspace.
 * @param {import('vscode').DiagnosticCollection} diagnostics
 *   Diagnostic collection.
 * @param {import('./tokens').TokenManager} tokenManager
 *   Token manager.
 *
 * @return {function(import('vscode').TextDocument): void}
 *   The validator function.
 */
const validateDocument = (window, workspace, diagnostics, tokenManager) => (document) => {
  if (document.languageId !== 'php' || document.isClosed) {
    return;
  }

  const token = tokenManager.registerToken(document.uri.fsPath);
  const resultPromise = createRunner(workspace, token, document.uri).phpcs(document.getText());

  resultPromise
    .then((result) => {
      if (document.isClosed) {
        // Clear diagnostics on a closed document.
        diagnostics.delete(document.uri);
        // If the command was not cancelled.
      } else if (result !== null) {
        diagnostics.set(document.uri, reportFlatten(result));
      }
    })
    .catch((error) => {
      // Show all errors apart from global phpcs missing error, due to the
      // fact that this is currently the default base option and could be
      // quite noisy for users with only project-level sniffers.
      if (error.message !== 'spawn phpcs ENOENT') {
        window.showErrorMessage(error.message);
      }

      // Reset diagnostics for the document if there was an error.
      diagnostics.delete(document.uri);
    });

  window.setStatusBarMessage('PHP Sniffer: validating…', resultPromise);
};

/**
 * VSCode API space used by createValidator().
 *
 * @typedef {object} VSCode
 *
 * @property {typeof import('vscode').languages} languages
 * @property {typeof import('vscode').window} window
 * @property {typeof import('vscode').workspace} workspace
 * @property {typeof import('vscode').CancellationTokenSource} CancellationTokenSource
 */

/**
 * The validator.
 *
 * @param {VSCode} vscode
 *   The VSCode API space.
 *
 * @return {import('vscode').Disposable}
 *   The disposable to dispose the validator.
 */
module.exports.createValidator = ({ languages, window, workspace, CancellationTokenSource }) => {
  const diagnostics = languages.createDiagnosticCollection('php');
  const tokenManager = createTokenManager(() => new CancellationTokenSource());

  const validate = validateDocument(window, workspace, diagnostics, tokenManager);
  const validatorRuntime = createValidatorRuntime(validate);
  const resetMe = reset.bind(null, diagnostics, tokenManager, workspace, validatorRuntime);

  const workspaceListeners = [
    workspace.onDidChangeConfiguration(isRunAffect(resetMe)),
    workspace.onDidOpenTextDocument(validate),
    workspace.onDidCloseTextDocument(onDocumentClose(diagnostics, tokenManager)),
    workspace.onDidChangeWorkspaceFolders(resetMe),
  ];

  resetMe();

  return {
    dispose() {
      diagnostics.clear();
      diagnostics.dispose();
      validatorRuntime.dispose();
      tokenManager.clearTokens();
      workspaceListeners.forEach((listener) => listener.dispose());
    },
  };
};