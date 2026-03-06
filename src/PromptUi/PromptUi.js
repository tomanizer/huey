import { byId } from '../util/dom/dom.js';

export class PromptUi {

  static {

    const acceptButton = byId('promptDialogAcceptButton');
    if (acceptButton) {
      acceptButton.addEventListener('click', (_event) =>{
        const dialog = byId('promptUi');
        if (!dialog) {
          return;
        }
        dialog.returnValue = 'accept';
        // firefox seems to forget the returnValue
        dialog.setAttribute('data-returnValue', dialog.returnValue);
      });
    }

    const rejectButton = byId('promptDialogRejectButton');
    if (rejectButton) {
      rejectButton.addEventListener('click', (_event) =>{
        const dialog = byId('promptUi');
        if (!dialog) {
          return;
        }
        dialog.returnValue = 'reject';
        // firefox seems to forget the returnValue
        dialog.setAttribute('data-returnValue', dialog.returnValue);
      });
    }

  }

  static show(config){
    return new Promise((resolve, _reject) =>{
      const promptDialog = byId( 'promptUi');
      const ariaLabel = promptDialog.querySelector('#' + promptDialog.getAttribute('aria-labelledby'))
      ariaLabel.textContent = config.title;
      const section = promptDialog.querySelector('section')
      section.replaceChildren();
      const contents = config.contents;
      if (typeof contents === 'string') {
        if (config.allowUnsafeHtml === true) {
          section.insertAdjacentHTML('beforeend', contents);
        }
        else {
          section.textContent = contents;
        }
      }
      else
      if (contents && typeof contents === 'object' && typeof contents.nodeType === 'number') {
        section.appendChild(contents);
      }

      const closeHandler = function(_event){
        byId('promptUi').removeEventListener('close', closeHandler);
        resolve(byId('promptUi').getAttribute('data-returnValue'));
      };
      promptDialog.addEventListener('close', closeHandler);
      promptDialog.showModal();
      const firstInput = promptDialog.querySelector('section input:not([type="hidden"]), section textarea, section select');
      if (firstInput) {
        firstInput.focus();
      }
    });
  }
}
