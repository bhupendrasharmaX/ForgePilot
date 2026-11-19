import os
import re
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Preformatted, HRFlowable

def generate_pdf():
    md_path = os.path.abspath("docs/TECHNICAL_WRITEUP.md")
    pdf_path = os.path.abspath("docs/TECHNICAL_WRITEUP.pdf")
    
    with open(md_path, "r", encoding="utf-8") as f:
        text = f.read()
        
    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=letter,
        rightMargin=40,
        leftMargin=40,
        topMargin=40,
        bottomMargin=40
    )
    
    styles = getSampleStyleSheet()
    
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontSize=18,
        leading=22,
        textColor=colors.HexColor('#0F172A'),
        spaceAfter=10
    )
    
    h1_style = ParagraphStyle(
        'H1',
        parent=styles['Heading2'],
        fontSize=13,
        leading=16,
        textColor=colors.HexColor('#1E293B'),
        spaceBefore=12,
        spaceAfter=4
    )
    
    h2_style = ParagraphStyle(
        'H2',
        parent=styles['Heading3'],
        fontSize=10,
        leading=13,
        textColor=colors.HexColor('#334155'),
        spaceBefore=8,
        spaceAfter=3
    )
    
    body_style = ParagraphStyle(
        'Body',
        parent=styles['Normal'],
        fontSize=8.5,
        leading=11.5,
        textColor=colors.HexColor('#1E293B'),
        spaceAfter=3
    )
    
    code_style = ParagraphStyle(
        'CodeStyle',
        parent=styles['Code'],
        fontSize=7.5,
        leading=9.5,
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
                story.append(Spacer(1, 4))
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
            story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#94A3B8'), spaceAfter=6))
        elif stripped.startswith("## "):
            story.append(Paragraph(stripped[3:], h1_style))
        elif stripped.startswith("### "):
            story.append(Paragraph(stripped[4:], h2_style))
        elif stripped.startswith("---"):
            story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#CBD5E1'), spaceBefore=4, spaceAfter=4))
        elif stripped.startswith("|"):
            story.append(Preformatted(line, code_style))
        else:
            safe = stripped.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            safe = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', safe)
            safe = re.sub(r'`(.*?)`', r'<font face="Courier">\1</font>', safe)
            story.append(Paragraph(safe, body_style))
            
    doc.build(story)
    print(f"Generated PDF: {pdf_path}")

if __name__ == "__main__":
    generate_pdf()
