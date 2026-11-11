export function makeRendererHtml() {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style></head><body><script type="module">
    const send = (message) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
    try {
      const pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
      window.convertPdf = async ({ base64, scale, format }) => {
        try {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          const loadingTask = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false });
          window.__pdf888LoadingTask = loadingTask;
          loadingTask.onPassword = (updatePassword, reason) => {
            window.__pdf888UpdatePassword = updatePassword;
            send({ type: 'passwordRequired', incorrect: reason === 2 });
          };
          const pdf = await loadingTask.promise;
          window.__pdf888UpdatePassword = null;
          send({ type: 'started', total: pdf.numPages });
          const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
          for (let number = 1; number <= pdf.numPages; number += 1) {
            const page = await pdf.getPage(number);
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext('2d', { alpha: format !== 'jpg' });
            if (format === 'jpg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }
            await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
            const data = canvas.toDataURL(mime, format === 'jpg' ? 0.9 : undefined).split(',')[1];
            send({ type: 'page', page: number, total: pdf.numPages, mime, data });
            canvas.width = 0; canvas.height = 0;
            page.cleanup();
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          const pageTotal = pdf.numPages;
          await pdf.destroy();
          window.__pdf888LoadingTask = null;
          send({ type: 'complete', total: pageTotal });
        } catch (error) {
          window.__pdf888LoadingTask = null;
          window.__pdf888UpdatePassword = null;
          send({ type: 'error', message: String(error?.message || error) });
        }
      };
      window.cancelPdf = () => {
        const task = window.__pdf888LoadingTask;
        window.__pdf888UpdatePassword = null;
        window.__pdf888LoadingTask = null;
        if (task) task.destroy();
      };
      send({ type: 'ready' });
    } catch (error) {
      send({ type: 'engineError', message: String(error?.message || error) });
    }
  </script></body></html>`;
}
