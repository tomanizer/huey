import { TabUi } from '../Tabs/Tabs.js';
import { clearSearch } from '../Search/Search.js';
import { uploadUi } from '../UploadUi/UploadUi.js';
import { queryModel } from '../QueryModel/QueryModel.js';
import { attributeUi } from '../AttributeUi/AttributeUi.js';
import { showErrorDialog } from '../ErrorDialog/ErrorDialog.js';

export function analyzeDatasource(datasource){
  try {
    TabUi.setSelectedTab('#sidebar', '#attributesTab');
    clearSearch();
    const uploadDialog = uploadUi.getDialog();
    if (uploadDialog && uploadDialog.open) {
      uploadDialog.close();
    }
    queryModel.setDatasource(datasource);
  }
  catch (error) {
    attributeUi.clear(false);
    const title = `Error reading datasource ${datasource.getId()}`;
    console.error(title);
    const description = error.message;
    console.error(error);
    showErrorDialog({
      title: title,
      description: description
    });
  }
}
