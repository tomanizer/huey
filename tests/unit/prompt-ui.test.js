describe('PromptUi content rendering', () => {
  async function setupPromptUi(){
    document.body.innerHTML = `
      <dialog id="promptUi" aria-labelledby="promptUiTitle" data-returnValue="accept">
        <h1 id="promptUiTitle"></h1>
        <section></section>
        <button id="promptDialogAcceptButton" type="button">Accept</button>
        <button id="promptDialogRejectButton" type="button">Reject</button>
      </dialog>
    `;
    const promptDialog = document.getElementById('promptUi');
    promptDialog.showModal = vi.fn();
    vi.resetModules();
    return import('../../src/PromptUi/PromptUi.js');
  }

  test('treats string contents as plain text by default', async () => {
    const { PromptUi } = await setupPromptUi();
    const promptPromise = PromptUi.show({
      title: 'Test prompt',
      contents: '<input id="shouldNotRender" />'
    });

    const section = document.querySelector('#promptUi section');
    expect(section.querySelector('#shouldNotRender')).toBeNull();
    expect(section.textContent).toContain('<input id="shouldNotRender" />');

    document.getElementById('promptUi').dispatchEvent(new Event('close'));
    await promptPromise;
  });

  test('renders string contents as html only when explicitly enabled', async () => {
    const { PromptUi } = await setupPromptUi();
    const promptPromise = PromptUi.show({
      title: 'Test prompt',
      contents: '<input id="shouldRender" />',
      allowUnsafeHtml: true
    });

    const section = document.querySelector('#promptUi section');
    expect(section.querySelector('#shouldRender')).not.toBeNull();

    document.getElementById('promptUi').dispatchEvent(new Event('close'));
    await promptPromise;
  });

  test('resets stale return values before showing a new prompt', async () => {
    const { PromptUi } = await setupPromptUi();
    const promptPromise = PromptUi.show({
      title: 'Fresh prompt',
      contents: 'Nothing selected yet'
    });

    document.getElementById('promptUi').dispatchEvent(new Event('close'));

    await expect(promptPromise).resolves.toBe('');
  });
});
