import { useRef } from 'react';
import type { DocumentSession } from '../session/useDocumentSession';
import { useDialogFocus } from './useDialogFocus';

type Props = {
  state: Pick<DocumentSession['state'], 'dialog' | 'saveState' | 'documentOpenPending'>;
  actions: DocumentSession['actions'];
  restoreEditor: () => void;
};

export function ConfirmationDialogs({ state, actions, restoreEditor }: Props) {
  const { dialog, saveState, documentOpenPending } = state;
  const conflict = dialog?.kind === 'conflict' ? dialog : null;
  const pendingExternal = dialog?.kind === 'external' ? dialog : null;
  const discardDialog = dialog?.kind === 'discard' ? dialog : null;
  const { cancelDialog: cancelDiscardDialog, confirmConflict: resolveConflict,
    confirmExternal: handleConfirmExternal, saveAndClose: handleSaveAndProceed } = actions;
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogKey = dialog?.kind === 'conflict' ? 'conflict-' + dialog.step : dialog?.kind ?? null;
  useDialogFocus(dialogRef, dialogKey, restoreEditor);
  return <>
    {pendingExternal && !conflict ? (
      <div className="modal-backdrop" data-testid="external-link-modal">
        <div ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="ext-title">
          <h2 id="ext-title">安全提示</h2>
          <p>您即将访问外部链接，确认离开此应用程序吗？</p>
          <p className="modal-url">{pendingExternal.url}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              data-testid="external-cancel"
              onClick={cancelDiscardDialog}
            >
              取消
            </button>
            <button
              type="button"
              className="button button--primary"
              data-testid="external-confirm"
              onClick={() => void handleConfirmExternal()}
            >
              继续访问
            </button>
          </div>
        </div>
      </div>
    ) : null}

    {conflict ? (
      <div className="modal-backdrop" data-testid="conflict-modal" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); cancelDiscardDialog(); }
      }}>
        <div ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
          <h2 id="conflict-title">文件已被外部修改</h2>
          <p>{conflict.step === 'overwrite' ? '确认用当前草稿覆盖检测到的外部版本？' : conflict.step === 'reload' ? '重新加载将放弃当前草稿，确认继续？' : conflict.message}</p>
          {conflict.step === 'overwrite' && saveState.status === 'error' ? (
            <p className="modal-feedback modal-feedback--error" role="alert">{saveState.message}</p>
          ) : null}
          <div className="modal-actions">
            <button type="button" className="button" disabled={saveState.status === 'saving'} onClick={() => cancelDiscardDialog()}>继续编辑</button>
            {conflict.step === 'choose' ? <>
              <button type="button" className="button" onClick={() => actions.chooseConflict('reload')}>重新加载</button>
              <button type="button" className="button button--danger" onClick={() => actions.chooseConflict('overwrite')}>覆盖外部版本</button>
            </> : <button type="button" className="button button--danger" disabled={saveState.status === 'saving' || documentOpenPending}
              onClick={() => void resolveConflict()}>{conflict.step === 'overwrite' ? '确认覆盖' : '放弃草稿并重新加载'}</button>}
          </div>
        </div>
      </div>
    ) : null}

    {discardDialog && !conflict && !pendingExternal ? (
      <div
        className="modal-backdrop"
        data-testid="discard-modal"
        onClick={(event) => {
          if (event.target === event.currentTarget && discardDialog.reason === 'close') {
            cancelDiscardDialog();
          }
        }}
      >
        <div ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="discard-title">
          <h2 id="discard-title">未保存更改</h2>
          <p>当前文档有未保存更改。</p>
          {discardDialog.reason === 'close' && documentOpenPending ? (
            <p
              className="modal-feedback"
              data-testid="close-save-feedback"
              role="status"
            >
              正在打开文档，请稍候。
            </p>
          ) : discardDialog.reason === 'close' && saveState.status === 'error' ? (
            <p
              className="modal-feedback modal-feedback--error"
              data-testid="close-save-feedback"
              role="alert"
            >
              {saveState.message}
            </p>
          ) : null}
          <div className="modal-actions">
            {discardDialog.reason === 'close' ? (
              <>
                <button type="button" className="button" data-testid="close-cancel" onClick={cancelDiscardDialog}>
                  继续编辑
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  data-testid="close-discard"
                  disabled={saveState.status === 'saving'}
                  onClick={actions.discardChanges}
                >
                  不保存并退出
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  data-testid="close-save"
                  disabled={saveState.status === 'saving' || documentOpenPending}
                  onClick={() => void handleSaveAndProceed()}
                >
                  保存并退出
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button"
                  data-testid="discard-cancel"
                  onClick={cancelDiscardDialog}
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  data-testid="discard-confirm"
                  onClick={actions.discardChanges}
                >
                  放弃更改
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    ) : null}
  </>;
}
