
// CompressLab PDF compression integration.
// Requires background-worker.js, gs-worker.js and gs-worker.wasm in the same folder.

(() => {
    const $ = id => document.getElementById(id);
    let selectedPdf = null;
    let pdfJobRunning = false;
    const workerURL = new URL('./background-worker.js', import.meta.url);
    const workerTimeout = 15 * 60 * 1000;

    function formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const index = Math.min(Math.floor(Math.log(bytes || 1) / Math.log(1024)), units.length - 1);
        return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`;
    }

    function setStatus(message, type = '') {
        const element = $('documentStatus');
        if (!element) return;
        element.textContent = message;
        element.classList.remove('hidden', 'error', 'success');
        if (!message) element.classList.add('hidden');
        if (type) element.classList.add(type);
    }

    function setProgress(percent, title, hint = '') {
        const value = Math.max(0, Math.min(100, percent));
        if ($('documentPercent')) $('documentPercent').textContent = `${Math.round(value)}%`;
        if ($('documentBar')) $('documentBar').style.width = `${value}%`;
        if ($('documentProgressText')) $('documentProgressText').textContent = title;
        if ($('documentProgressHint')) $('documentProgressHint').textContent = hint;
    }

    function showProgress(show) {
        $('documentProgress')?.classList.toggle('hidden', !show);
    }

    function log(message, type = 'info') {
        const output = $('consoleOutput');
        if (!output) return;
        const entry = document.createElement('div');
        entry.className = `console-entry console-${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        output.appendChild(entry);
        output.scrollTop = output.scrollHeight;
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function compressedName(filename) {
        const base = filename.replace(/\.[^/.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
        return `${base}-compressed.pdf`;
    }

    function choosePdf(file) {
        if (!file) return;
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

        if (!isPdf) {
            setStatus('Please choose a PDF file. Word documents are not supported by Ghostscript.', 'error');
            return;
        }

        if (!file.size) {
            setStatus('The selected PDF is empty.', 'error');
            return;
        }

        selectedPdf = file;
        $('documentName').textContent = file.name;
        $('documentDetails').textContent = `${formatSize(file.size)} • PDF document`;
        $('documentFileCard')?.classList.remove('hidden');
        $('documentResult')?.classList.add('hidden');
        $('compressDocument').disabled = false;
        showProgress(false);
        setProgress(0, 'Ready to compress.', 'Choose a quality preset and start compression.');
        setStatus('PDF selected. Your original file will remain unchanged.');
        log(`PDF selected: ${file.name} (${formatSize(file.size)})`);
    }

    function runGhostscript(file, quality, onStage) {
        return new Promise(async (resolve, reject) => {
            let worker = null;
            let inputURL = null;
            let settled = false;
            let timeoutId;

            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);

                if (inputURL) URL.revokeObjectURL(inputURL);

                try {
                    worker?.terminate();
                } catch (_) {}

                if (error) reject(error);
                else resolve(result);
            };

            timeoutId = setTimeout(() => {
                finish(new Error('PDF compression timed out. Try a smaller PDF or a less complex document.'));
            }, workerTimeout);

            try {
                onStage('Reading PDF...', 5);

                const source = new Blob(
                    [await file.arrayBuffer()],
                    { type: 'application/pdf' }
                );

                inputURL = URL.createObjectURL(source);

                onStage('Starting Ghostscript WebAssembly...', 12);

                worker = new Worker(workerURL);

                worker.onmessage = async event => {
                    try {
                        if (
                            typeof event.data !== 'string' ||
                            !event.data.startsWith('blob:')
                        ) {
                            throw new Error('Ghostscript returned an unexpected response.');
                        }

                        onStage('Retrieving optimized PDF...', 92);

                        const response = await fetch(event.data);
                        URL.revokeObjectURL(event.data);

                        if (!response.ok) {
                            throw new Error(`Could not retrieve compressed PDF (HTTP ${response.status}).`);
                        }

                        const output = await response.blob();

                        if (!output.size) {
                            throw new Error('Ghostscript produced an empty PDF.');
                        }

                        finish(null, new Blob([output], {
                            type: 'application/pdf'
                        }));

                    } catch (error) {
                        finish(error);
                    }
                };

                worker.onerror = event => {
                    event.preventDefault?.();

                    finish(new Error(
                        event.message ||
                        'Ghostscript worker failed. Check that all three Ghostscript files are uploaded beside index.html.'
                    ));
                };

                worker.onmessageerror = () => {
                    finish(new Error('Could not read the response from the Ghostscript worker.'));
                };

                worker.postMessage({
                    data: {
                        psDataURL: inputURL,
                        quality
                    },
                    target: 'wasm'
                });

                onStage('Optimizing PDF with Ghostscript...', 20);

            } catch (error) {
                finish(error);
            }
        });
    }

    function renderResult(original, compressed) {
        const result = $('documentResult');
        result.innerHTML = '';

        const heading = document.createElement('h3');
        heading.textContent = 'PDF compression complete';

        const stats = document.createElement('div');
        stats.className = 'stats';

        const difference = original.size
            ? ((compressed.size - original.size) / original.size) * 100
            : 0;

        const differenceText = difference <= 0
            ? `${Math.abs(difference).toFixed(1)}% smaller`
            : `${difference.toFixed(1)}% larger`;

        [
            ['Before', formatSize(original.size)],
            ['After', formatSize(compressed.size)],
            ['Size change', differenceText]
        ].forEach(([label, value]) => {
            const stat = document.createElement('div');
            stat.className = 'stat';

            const name = document.createElement('span');
            name.textContent = label;

            const amount = document.createElement('strong');
            amount.textContent = value;

            stat.append(name, amount);
            stats.append(stat);
        });

        const note = document.createElement('p');

        note.textContent = difference < 0
            ? 'The optimized PDF is smaller than the original.'
            : difference > 0
                ? 'This PDF became larger. Try the maximum-compression preset if you want a smaller output.'
                : 'The optimized PDF is approximately the same size as the original.';

        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'download-link';
        download.textContent = 'Download compressed PDF';

        download.addEventListener('click', () => {
            downloadBlob(compressed, compressedName(original.name));
            log('Compressed PDF download started.', 'success');
        });

        result.append(heading, stats, note, download);
        result.classList.remove('hidden');
    }

    async function compressSelectedPdf() {
        if (!selectedPdf || pdfJobRunning) return;

        pdfJobRunning = true;
        $('compressDocument').disabled = true;
        $('documentResult')?.classList.add('hidden');

        showProgress(true);
        setStatus('Compressing PDF locally. Your original file is unchanged.');

        const quality = $('documentQuality')?.value || '/ebook';

        const presetNames = {
            '/screen': 'Maximum compression',
            '/ebook': 'Balanced',
            '/printer': 'High quality',
            '/prepress': 'Maximum quality'
        };

        const started = Date.now();

        log(`Starting PDF compression: ${selectedPdf.name} (${presetNames[quality] || quality})`);

        try {
            const output = await runGhostscript(
                selectedPdf,
                quality,
                (stage, percent) => {
                    const seconds = Math.max(
                        0,
                        Math.floor((Date.now() - started) / 1000)
                    );

                    const elapsed = seconds < 60
                        ? `${seconds}s`
                        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

                    setProgress(
                        percent,
                        stage,
                        `${presetNames[quality] || quality} preset • Elapsed: ${elapsed}. Ghostscript does not expose live percentage progress.`
                    );
                }
            );

            setProgress(
                100,
                'Compression complete.',
                'Your optimized PDF is ready to download.'
            );

            renderResult(selectedPdf, output);

            const reduction = selectedPdf.size
                ? ((selectedPdf.size - output.size) / selectedPdf.size) * 100
                : 0;

            setStatus(
                reduction > 0
                    ? `PDF compressed successfully. File size reduced by ${reduction.toFixed(1)}%.`
                    : `Optimization finished. The output is ${Math.abs(reduction).toFixed(1)}% ${reduction < 0 ? 'larger' : 'different in size'} than the original.`,
                'success'
            );

            log(
                `PDF compression complete: ${formatSize(selectedPdf.size)} → ${formatSize(output.size)} (${reduction.toFixed(1)}% reduction)`,
                'success'
            );

        } catch (error) {
            const message = error?.message || 'PDF compression failed.';

            setStatus(message, 'error');

            setProgress(
                0,
                'Compression failed.',
                'Your original PDF has not been changed. Check the console for details.'
            );

            log(`PDF compression failed: ${message}`, 'error');

        } finally {
            pdfJobRunning = false;
            $('compressDocument').disabled = !selectedPdf;
        }
    }

    function clearPdf() {
        selectedPdf = null;

        $('documentFileCard')?.classList.add('hidden');
        $('documentResult')?.classList.add('hidden');
        $('compressDocument').disabled = true;

        showProgress(false);
        setStatus('');

        log('PDF selection cleared.');
    }

    // Capture these events before the older gzip handlers in script.js.

    document.addEventListener('keydown', event => {
        if (
            event.target?.id !== 'documentDrop' ||
            !['Enter', ' '].includes(event.key)
        ) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        $('documentFile')?.click();
    }, true);

    document.addEventListener('click', event => {
        if (
            event.target?.id !== 'documentFile' &&
            event.target?.closest('#documentDrop')
        ) {
            event.preventDefault();
            event.stopImmediatePropagation();

            $('documentFile')?.click();
            return;
        }

        if (event.target?.closest('#compressDocument')) {
            event.preventDefault();
            event.stopImmediatePropagation();

            compressSelectedPdf();
            return;
        }

        if (event.target?.closest('#removeDocument')) {
            event.preventDefault();
            event.stopImmediatePropagation();

            clearPdf();
        }
    }, true);

    document.addEventListener('change', event => {
        if (event.target?.id !== 'documentFile') return;

        event.stopImmediatePropagation();

        const file = event.target.files?.[0];

        if (file) choosePdf(file);

        event.target.value = '';
    }, true);

    document.addEventListener('dragover', event => {
        if (!event.target?.closest?.('#documentDrop')) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        $('documentDrop')?.classList.add('drag');
    }, true);

    document.addEventListener('dragleave', event => {
        if (!event.target?.closest?.('#documentDrop')) return;

        event.stopImmediatePropagation();

        $('documentDrop')?.classList.remove('drag');
    }, true);

    document.addEventListener('drop', event => {
        if (!event.target?.closest?.('#documentDrop')) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        $('documentDrop')?.classList.remove('drag');

        const file = event.dataTransfer?.files?.[0];

        if (file) choosePdf(file);
    }, true);

    if ($('compressDocument')) {
        $('compressDocument').disabled = true;
    }

    log('Ghostscript PDF integration loaded.', 'success');
})();
