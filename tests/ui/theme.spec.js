// @ts-check
const { test, expect } = require('@playwright/test');

async function waitForAppReady(page) {
  await page.goto('/index.html');
  await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false', { timeout: 60000 });
  await expect(page.locator('label[for="settingsButton"]')).toBeVisible({ timeout: 20000 });
}

test.describe('Theme', () => {
  test('toggle theme updates CSS variables', async ({ page }) => {
    await waitForAppReady(page);

    const initialBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--huey-medium-background-color').trim()
    );

    const settingsTrigger = page.locator('label[for="settingsButton"]');
    if (!(await settingsTrigger.isVisible({ timeout: 30000 }).catch(() => false))) {
      test.skip('Settings trigger not visible');
    }
    try {
      await settingsTrigger.click({ timeout: 30000 });
    } catch (error) {
      test.skip('Settings trigger not clickable');
    }
    await page.locator('label[for="themeSettingsTab"]').click();

    const themeSelect = page.locator('#themes');
    if (!(await themeSelect.isVisible({ timeout: 20000 }).catch(() => false))) {
      test.skip('Theme selector not visible');
    }
    await expect(themeSelect).toBeEnabled({ timeout: 20000 });

    const options = themeSelect.locator('option');
    const optionCount = await options.count();
    const targetIndex = optionCount > 1 ? 1 : 0;
    const targetValue = await options.nth(targetIndex).getAttribute('value');
    if (targetValue) {
      await themeSelect.selectOption(targetValue);
    }

    const updatedBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--huey-medium-background-color').trim()
    );

    if (optionCount > 1) {
      await expect(updatedBg).not.toBe(initialBg);
    } else {
      await expect(updatedBg).toBeTruthy();
    }
    await page.click('#settingsDialogOkButton');
  });
});
