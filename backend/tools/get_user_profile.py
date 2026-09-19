import os
import json
# from tex_to_pdf import cv_pipeline
# from job_scraper import scrape
from strands import tool

def _data_path(filename):
    """Resolve backend/data/<filename> regardless of CWD."""
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", filename)


def get_experiences():
    path = _data_path("experiences.json")
    with open(path, "r", encoding="utf-8") as f:
        exp = json.load(f)

    formatted_string = "# Experiences\n"
    count = 1
    for experience in exp:
        formatted_string += f"\n{count}) "
        formatted_string += f"Position: {experience.get('title')}\n\n"
        formatted_string += f"Company: {experience.get('organization')}\n\n"
        formatted_string += f"Description: {experience.get('description')}\n\n"
        formatted_string += f"Duration: {experience.get('date')}\n\n"
        formatted_string += "-"*60
        count += 1

    return formatted_string


def get_coursework():
    path = _data_path("coursework.json")
    with open(path, "r", encoding="utf-8") as f:
        coursework = json.load(f)

    formatted_string = "# Coursework\n"
    count = 1
    for course in coursework:
        formatted_string += f"\n{count}) "
        formatted_string += f"Title: {course.get('title')}\n\n"
        formatted_string += f"Stack and Course: {course.get('stack')}\n\n"
        formatted_string += f"Description: {course.get('description')}\n\n"
        formatted_string += "-"*60
        count += 1

    return formatted_string

def get_projects():
    path = _data_path("projects.json")
    with open(path, "r", encoding="utf-8") as f:
        projects = json.load(f)

    formatted_string = "# Projects\n"
    count = 1
    for project in projects:
        formatted_string += f"\n{count}) "
        formatted_string += f"Title: {project.get('title')}\n\n"
        formatted_string += f"Stack and Course: {project.get('stack')}\n\n"
        formatted_string += f"Description: {project.get('description')}\n\n"
        formatted_string += f"Link: {project.get('link')}\n\n"
        formatted_string += "-"*60
        count += 1

    return formatted_string

@tool
def get_profile_summary():
    combined_string = ""
    combined_string += "\n\n" + get_experiences()
    combined_string += "\n\n" + get_projects()
    combined_string += "\n\n" + get_coursework()

    return combined_string

# @tool
# def generate_cover_letter(company_name: str, title: str, body: str):
#     # Generates cover letter
#     try:
#         cv_pipeline(company_name, title, body)
#         return "Success!"
#     except Exception as e:
#         return f"Error: {e}"

# @tool
# def job_description_scraper(url):
#     return scrape(url)

if __name__ == "__main__":
    print(get_profile_summary())