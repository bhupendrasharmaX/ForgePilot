import os
import re
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Preformatted, HRFlowable
import pypdf

def generate_pdf():
    md_path = os.path.abspath("docs/TECHNICAL_WRITEUP.md")
    pdf_path = os.path.abspath("docs/TECHNICAL_WRITEUP.pdf")
    
    with open(md_path, "r", encoding="utf-8") as f:
        full_text = f.read()

    # The official competition specification requires 1 to 3 pages with the eight required headings.
    # Sections 9 and 10 in the markdown file are internal demo scripts and video checklists.
    idx = full_text.find("## 9.")
    text = full_text[:idx].strip() if idx != -1 else full_text
        
    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=letter,
        rightMargin=36,
        leftMargin=36,
        topMargin=32,
        bottomMargin=32
    )
    
    styles = getSampleStyleSheet()
    
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontSize=16,
        leading=19,
        textColor=colors.HexColor('#0F172A'),
        spaceAfter=6
    )
    
    h1_style = ParagraphStyle(
        'H1',
        parent=styles['Heading2'],
        fontSize=11,
        leading=14,
        textColor=colors.HexColor('#1E293B'),
        spaceBefore=8,
        spaceAfter=3
    )
    
    h2_style = ParagraphStyle(
        'H2',
        parent=styles['Heading3'],
        fontSize=9.5,
        leading=12,
        textColor=colors.HexColor('#334155'),
        spaceBefore=6,
        spaceAfter=2
    )
    
    body_style = ParagraphStyle(
        'Body',
        parent=styles['Normal'],
        fontSize=8,
        leading=10.6,
        textColor=colors.HexColor('#1E293B'),
        spaceAfter=2.5
    )
    
    code_style = ParagraphStyle(
        'CodeStyle',
        parent=styles['Code'],
        fontSize=6.8,
        leading=8.5,
        textColor=colors.HexColor('#0F172A'),
        backColor=colors.HexColor('#F8FAFC')
    )

    story = []
    lines = text.split("\n")
    in_code = False
    code_buf = []

    for line in lines:
        if line.strip().startswith("```"):
            if in_code:
                in_code = False
                story.append(Preformatted("\n".join(code_buf), code_style))
                story.append(Spacer(1, 3))
                code_buf = []
            else:
                in_code = True
                code_buf = []
            continue
            
        if in_code:
            code_buf.append(line)
            continue
            
        stripped = line.strip()
        if not stripped:
            continue
            
        if stripped.startswith("# "):
            story.append(Paragraph(stripped[2:], title_style))
            story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#94A3B8'), spaceAfter=4))
        elif stripped.startswith("## "):
            story.append(Paragraph(stripped[3:], h1_style))
        elif stripped.startswith("### "):
            story.append(Paragraph(stripped[4:], h2_style))
        elif stripped.startswith("---"):
            story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#CBD5E1'), spaceBefore=3, spaceAfter=3))
        elif stripped.startswith("|"):
            story.append(Preformatted(line, code_style))
        else:
            safe = stripped.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            safe = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', safe)
            safe = re.sub(r'`(.*?)`', r'<font face="Courier">\1</font>', safe)
            story.append(Paragraph(safe, body_style))
            
    doc.build(story)

    reader = pypdf.PdfReader(pdf_path)
    count = len(reader.pages)
    print(f"Generated PDF successfully: {count} page(s) (Target: exactly 1-3 pages)")

if __name__ == "__main__":
    generate_pdf()
