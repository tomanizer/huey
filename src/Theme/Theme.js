import { byId } from '../util/dom/dom.js';
import { settings } from '../SettingsDialog/SettingsDialog.js';

export class Theme {

  static #variablePrefix = '--huey-';

  static #getRootStyle(){
    return document.querySelector(':root').style;
  }

  static #setCssVariable(variableName, variableValue){
    const style = Theme.#getRootStyle();
    style.setProperty(variableName, variableValue);
  }
  
  static #setCssVariables(themeVariables) {
    for (const property in themeVariables){ 
      if (!property.startsWith(Theme.#variablePrefix)){
        continue;
      }
      Theme.#setCssVariable(property, themeVariables[property]);
    }
  }

  static getAllThemeCSSVariables(){
    const variables = {};
    const rootStyle = this.#getRootStyle();
    for (const property in rootStyle){ 
      if (!property.startsWith(Theme.#variablePrefix)){
        continue;
      }
      variables[property] = rootStyle[property];
    }
    return variables;
  }

  static applyTheme(themeId){
    const theme = settings.getSettings(['themeSettings', 'themes', 'options', themeId]);
    const themeVariables = theme.value;
    Theme.#setCssVariables(themeVariables);
  }
  
  static updateCssVariable(control){
    const id = control.id;
    const previousIndex = 0;
    const variableName = id.split('').reduce((acc, curr) =>{
      const lowerCase = curr.toLowerCase();
      if (curr !== lowerCase){
        acc.push('');
      }
      acc[acc.length - 1] += lowerCase;
      return acc;
    }, [Theme.#variablePrefix]).join('-');
    
    Theme.#setCssVariable(variableName, control.value);
  }
    
  static {
    const themeVariables = settings.getSettings(['themeSettings', 'themes', 'value']);
    Theme.#setCssVariables(themeVariables);
  }
  
}

settings.addEventListener('change', (event) =>{
  const themes = byId('themes');
  Theme.applyTheme( themes.selectedIndex );  
});

/*
Theme editor - put it on ice for now.

              <!-- getComputedStyle(document.body).getPropertyValue('--huey-medium-background-color') -->
              <label for="textFontFamily">Text Font</label>
              <input type="text" id="textFontFamily" value="Verdana" onchange="updateCssVariable(this)"/>
              <label for="monoFontFamily">Monospace Font</label>
              <input type="text" id="monoFontFamily" value="Monospace" onchange="updateCssVariable(this)"/>

              <label for="foregroundColor">Foreground Color</label>
              <input type="color" id="foregroundColor" data-css-var="huey-foreground-color" onchange="updateCssVariable(this)"/>
              <label for="placeholderColor">Placeholder Color</label>
              <input type="color" id="placeholderColor" data-css-var="huey-placeholder-color" onchange="updateCssVariable(this)"/>
              
              <label for="lightBackgroundColor">Light Background Color</label>
              <input type="color" id="lightBackgroundColor" data-css-var="huey-icon-color-subtle" onchange="updateCssVariable(this)"/>
              <label for="mediumBackgroundColor">Medium Background Color</label>
              <input type="color" id="mediumBackgroundColor" onchange="updateCssVariable(this)"/>
              <label for="darkBackgroundColor">Dark Background Color</label>
              <input type="color" id="darkBackgroundColor" onchange="updateCssVariable(this)"/>

              <label for="lightBorderColor">Light Border Color</label>
              <input type="color" id="lightBorderColor" onchange="updateCssVariable(this)"/>
              <label for="darkBorderColor">Dark Border Color</label>
              <input type="color" id="darkBorderColor" onchange="updateCssVariable(this)"/>

              <label for="iconColor">Icon Color</label>
              <input type="color" id="iconColor" onchange="updateCssVariable(this)"/>
              <label for="iconColorSubtle">Icon Color Subtle</label>
              <input type="color" id="iconColorSubtle" onchange="updateCssVariable(this)"/>
              <label for="iconColorHighlight">Icon Color Highlight</label>
              <input type="color" id="iconColorHighlight" onchange="updateCssVariable(this)"/>

*/

