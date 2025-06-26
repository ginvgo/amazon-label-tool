// functions/api/process.js
import { PDFDocument, rgb } from 'pdf-lib';

export async function onRequest(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });
    }

    if (context.request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    try {
        const formData = await context.request.formData();
        const file = formData.get('file');
        const modificationsStr = formData.get('modifications');

        if (!file || typeof file === 'string' || !modificationsStr) {
            return new Response(JSON.stringify({ error: '请求无效，缺少文件或操作指令' }), { status: 400, headers: {'Content-Type': 'application/json'} });
        }

        const modifications = JSON.parse(modificationsStr);
        const pdfBytes = await file.arrayBuffer();
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pages = pdfDoc.getPages();

        // The core logic is now just to apply the modifications calculated by the client
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const pageMod = modifications.pages[i];

            if (pageMod) {
                // 1. Execute removal instructions
                pageMod.removeAreas.forEach(area => {
                    page.drawRectangle({
                        x: area.x,
                        y: area.y,
                        width: area.width,
                        height: area.height,
                        color: rgb(1, 1, 1),
                    });
                });

                // 2. Execute addition instructions
                const font = await pdfDoc.embedFont('Helvetica'); // Embed font on demand
                pageMod.addText.forEach(textInfo => {
                    const textWidth = font.widthOfTextAtSize(textInfo.text, textInfo.fontSize);
                    page.drawText(textInfo.text, {
                        x: textInfo.x - textWidth / 2, // center align
                        y: textInfo.y,
                        size: textInfo.fontSize,
                        font,
                        color: rgb(0, 0, 0),
                    });
                });
            }
        }

        const modifiedPdfBytes = await pdfDoc.save();

        return new Response(modifiedPdfBytes, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="processed_${file.name}"`,
                'Access-Control-Allow-Origin': '*',
            },
        });

    } catch (error) {
        console.error('Backend Error:', error);
        return new Response(JSON.stringify({ error: `服务器处理失败: ${error.message}` }), { status: 500, headers: {'Content-Type': 'application/json'} });
    }
}
