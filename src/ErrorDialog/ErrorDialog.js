import { byId, escapeHtmlText } from '../util/dom/dom.js';

let errorDialogFocusOrigin;

export function getDataFromError(error){
  const newlineRegex = /\r\n|[\r\n]/g;
  
  const message = error.message;
  let messageLines;
  if (message) {
    messageLines = message.split(newlineRegex);
    messageLines = messageLines.filter((messageLine) =>{
      return messageLine.trim() !== '';
    });
  }
  
  const stack = error.stack;
  let stackLines;
  let _description;
  if (stack) {
    stackLines = stack.split(newlineRegex);
  }
    
  return {
    type: error.name || 'Unknown Error',
    title: messageLines ? messageLines[0] : 'Error',
    description: messageLines ? messageLines.slice(1) : ['Unexpected error.'],
    details: stackLines ? stackLines.join('\n') : ''
  };
}


export function showErrorDialog(config){
  if (config instanceof Error){
    console.error(config);
    config = getDataFromError(config);
  }
  
  let title = config.title;
  if (!title) {
    title = 'Unexpected Error';
  }
  if (config.type) {
    title = `${config.type}: ${title}`;
  }
  const errorDialogTitle = byId('errorDialogTitle');
  errorDialogTitle.textContent = title;
  
  let description = config.description;
  if (!description){
    description = title;
  }
  if (typeof description === 'string') {
    description = [description];
  }
  
  if (! (description instanceof Array) ) {
    description = [];
  }
  
  const errorDialogDescription = byId('errorDialogDescription');
  errorDialogDescription.innerHTML = description.map(escapeHtmlText).join('<br/>');

  const errorDialogDetails = byId('errorDialogDetails');
  errorDialogDetails.removeAttribute('open');
  
  const errorDialogStack = byId('errorDialogStack');
  const details = config.details || '';
  errorDialogStack.textContent = details;

  const errorDialog = byId('errorDialog');
  errorDialogFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  errorDialog.showModal();
  byId('errorDialogOkButton').focus();
}

function initErrorDialog(){
  const errorDialog = byId('errorDialog');
  errorDialog.addEventListener('close', () =>{
    if (errorDialogFocusOrigin && typeof errorDialogFocusOrigin.focus === 'function') {
      errorDialogFocusOrigin.focus();
    }
    errorDialogFocusOrigin = undefined;
  });
  byId('errorDialogOkButton').addEventListener('click', (event) =>{
    event.cancelBubble = true;
    errorDialog.close();
  });
}
initErrorDialog()
