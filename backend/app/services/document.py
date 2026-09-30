"""One versioned form definition shared by preview and DOCX export."""
from io import BytesIO
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED

from app.workspace_models import Workspace

FORM_TEMPLATE = {
    'id': 'consultation-v1', 'title': 'Лист консультации',
    'format': 'A4', 'font': 'Arial', 'font_size_pt': 11,
    'fields': [
        {'key': 'complaints', 'label': 'Жалобы'},
        {'key': 'anamnesis', 'label': 'Анамнез'},
        {'key': 'allergies', 'label': 'Аллергии'},
        {'key': 'diagnosis', 'label': 'Диагноз'},
        {'key': 'prescriptions', 'label': 'Назначения'},
        {'key': 'recommendations', 'label': 'Рекомендации'},
    ],
}


def paragraph(text: str, bold=False, size=22, title=False):
    props = '<w:pStyle w:val="Title"/>' if title else ''
    if bold:
        props += '<w:keepNext/>'
    runs = []
    for i, line in enumerate(text.split('\n')):
        if i:
            runs.append('<w:r><w:br/></w:r>')
        # XML 1.0 excludes control characters, which can occur in pasted text.
        line = ''.join(c for c in line if ord(c) >= 32 or c == '\t')
        runs.append(f'<w:r><w:rPr>{"<w:b/>" if bold else ""}<w:sz w:val="{size}"/></w:rPr><w:t xml:space="preserve">{escape(line)}</w:t></w:r>')
    return f'<w:p><w:pPr>{props}<w:spacing w:after="140"/></w:pPr>{"".join(runs)}</w:p>'


def docx_bytes(workspace: Workspace) -> bytes:
    confirmed = workspace.confirmed_revision == workspace.revision and not workspace.context_stale
    status = 'Проверено врачом' if confirmed else 'Черновик — требует проверки врача'
    content = paragraph(FORM_TEMPLATE['title'], True, 32, True)
    content += paragraph(status, size=20)
    content += paragraph(f'Версия {workspace.revision} · {FORM_TEMPLATE["id"]}', size=18)
    for field in FORM_TEMPLATE['fields']:
        content += paragraph(field['label'], True)
        content += paragraph(getattr(workspace.fields, field['key']) or 'Не указано')
    document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{content}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body></w:document>'''
    styles = '''<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>'''
    out = BytesIO()
    with ZipFile(out, 'w', ZIP_DEFLATED) as package:
        package.writestr('[Content_Types].xml', '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>''')
        package.writestr('_rels/.rels', '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>''')
        package.writestr('word/_rels/document.xml.rels', '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''')
        package.writestr('word/document.xml', document)
        package.writestr('word/styles.xml', styles)
    return out.getvalue()
