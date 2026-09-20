from pathlib import Path
import re


def customize_resume(template_path, output_path, replacements):
    tex = Path(template_path).read_text(encoding="utf-8")

    for key, value in replacements.items():
        pattern = rf"(\\newcommand{{\\{re.escape(key)}}}{{)[^}}]*(}})"
        tex = re.sub(pattern, rf"\g<1>{value}\g<2>", tex)

    Path(output_path).write_text(tex, encoding="utf-8")


replacements = {
    "FullName": "Raihan Rafeek",
    "Email": "rafeekrn@mail.uc.edu",
    "LinkedInURL": "https://linkedin.com/in/raihan-rafeek",
    "LinkedInDisplay": "linkedin.com/in/raihan-rafeek",
    "GitHubURL": "https://github.com/rai1975",
    "GitHubDisplay": "github.com/rai1975",
    "PortfolioURL": "https://www.rai-1975.com",
    "PortfolioDisplay": "rai-1975.com",
    "University": "University of Cincinnati",
    "UniversityLocation": "Cincinnati, OH",
    "Degree": "Bachelor of Science in Computer Science",
    "GPA": "3.97",
    "GraduationDate": "May 2027",
}

customize_resume(
    "resume_template.tex",
    "resume.tex",
    replacements,
)