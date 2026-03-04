export function createClipboardItem(blob, mimeType){
  const conf = {};
  conf[mimeType || blob.type] = blob;
  return new ClipboardItem(conf);
}

export async function copyToClipboard(data, mimeType) {
  let clipboard = navigator.clipboard, method, arg;
  if (typeof data === 'string') {
    if (mimeType) {
      if (!ClipboardItem.supports(mimeType)){
        console.warn(`Clipboard does not support preferred mimeType ${mimeType}, downgrading to text/plain.`);
        mimeType = 'text/plain';
      }      
      data = new Blob([data], {type: mimeType});
    }
    else {
      method = clipboard.writeText;
      arg = data;
    }
  }
  if (data instanceof Blob){
    method = clipboard.write;
    arg = [createClipboardItem(data, mimeType)];
  }
  let result;
  try {
    result = await method.call(clipboard, arg);
  }
  catch(e){
    switch (e.name) {
      case 'NotAllowedError':
        // this is probably https://github.com/rpbouman/huey/issues/305,
        // which happens on chrome when we try to write to the clipboard but the document is not focused.
        console.warn(e);
        console.warn('Attempting to focus the document and retrying');
        document.defaultView.focus();
        result = await method.call(clipboard, arg);
        break;
      default:
        throw e;
    }
  }
  return result;
}

export function getPastedText(domClipboardEvent){
  const target = domClipboardEvent.target;
  const value = target.value;
  
  const selectionStart = domClipboardEvent.selectionStart === undefined ? value.length : domClipboardEvent.selectionStart;
  const prefix = value.slice(0, selectionStart);
  
  const selectionEnd = domClipboardEvent.selectionEnd === undefined ? value.length : domClipboardEvent.selectionEnd;
  const postfix = value.slice(selectionEnd);

  const data = domClipboardEvent.clipboardData;
  const mimeType = 'text/plain';
  const rawPasteText = data.getData(mimeType);

  return rawPasteText;
}
