const TaskMeta = require("../Models/TaskMeta.model");
const Task = require("../Models/task.model");
const DailyWorkUpdate = require("../Models/Dailyworkupdate");
const StandaloneWorkUpdate = require("../Models/StandaloneWorkUpdate");

/* ── GET /task-meta ──────────────────────────────────────── 
   Returns all categories and ALL projects (initial load)
   Automatically synchronizes and unifies categories across Task, DailyWorkUpdate, and TaskMeta collections.
────────────────────────────────────────────────────────── */
exports.getTaskMeta = async (req, res) => {
  try {
    const mappings = await TaskMeta.find().sort({ category: 1 });
    
    const categories = mappings.map(m => m.category);
    const projects = Array.from(new Set(mappings.flatMap(m => m.projects))).sort();

    // Use TaskMeta _id as the standard Category ID
    const fullCategories = mappings.map(m => ({ 
      _id: m._id, 
      name: m.category 
    }));
    
    // Create virtual project objects for frontend compatibility
    const fullProjects = mappings.flatMap(m => 
      m.projects.map(pName => ({
        _id: `${m.category}_${pName}`, // Composite ID
        name: pName,
        categoryId: { 
          _id: m._id, 
          name: m.category 
        }
      }))
    );

    const projectPages = mappings.flatMap(m =>
      (m.projectPages || []).map(pp => ({
        category: m.category,
        project: pp.project,
        pages: pp.pages || []
      }))
    );

    res.json({
      success: true,
      data: { categories, projects, fullCategories, fullProjects, projectPages },
    });
  } catch (err) {
    console.error("[GET_TASK_META] Error:", err.message);
    res.status(500).json({ message: "Failed to fetch task meta", error: err.message });
  }
};

/* ── GET /task-meta/projects/:categoryId ─────────────────── */
exports.getProjectsByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const mapping = await TaskMeta.findById(categoryId);
    
    if (!mapping) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    
    // Return formatted projects
    const projects = mapping.projects.map(pName => ({
      _id: `${mapping.category}_${pName}`,
      name: pName,
      categoryId: mapping._id
    }));

    res.json({
      success: true,
      data: projects
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ── POST /task-meta/category ────────────────────────────── */
exports.addCategory = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: "Name is required" });

    const trimmed = name.trim();
    const existing = await TaskMeta.findOne({ category: { $regex: new RegExp(`^${trimmed}$`, "i") } });
    
    if (existing) {
      return res.status(409).json({ message: "Category already exists" });
    }

    const categoryDoc = await TaskMeta.create({ 
      category: trimmed, 
      projects: [] 
    });

    res.status(201).json({
      success: true,
      message: `Category "${trimmed}" added`,
      data: { _id: categoryDoc._id, name: categoryDoc.category },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to add category", error: err.message });
  }
};

/* ── POST /task-meta/project ─────────────────────────────── */
exports.addProject = async (req, res) => {
  try {
    const { name, categoryId, categoryName } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ message: "Project name is required" });
    }

    const trimmed = name.trim();
    
    // Find category by ID or Name
    let mapping = null;
    if (categoryId) mapping = await TaskMeta.findById(categoryId);
    if (!mapping && categoryName) {
      mapping = await TaskMeta.findOne({
        category: { $regex: new RegExp(`^${categoryName.trim()}$`, "i") }
      });
    }

    if (!mapping) {
      if (categoryName && categoryName.trim()) {
        mapping = await TaskMeta.create({
          category: categoryName.trim(),
          projects: [trimmed]
        });
        return res.status(201).json({
          success: true,
          message: `Project "${trimmed}" added to "${mapping.category}"`,
          data: {
            _id: `${mapping.category}_${trimmed}`,
            name: trimmed,
            categoryId: mapping._id
          },
        });
      }
      return res.status(404).json({ message: "Category not found" });
    }

    // Check if project already exists in this category
    const alreadyExists = mapping.projects.some(p => p.toLowerCase() === trimmed.toLowerCase());
    if (alreadyExists) {
      return res.status(409).json({ message: "Project already exists in this category" });
    }

    // Add to projects array
    mapping.projects.push(trimmed);
    await mapping.save();

    res.status(201).json({
      success: true,
      message: `Project "${trimmed}" added to "${mapping.category}"`,
      data: {
        _id: `${mapping.category}_${trimmed}`,
        name: trimmed,
        categoryId: mapping._id
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to add project", error: err.message });
  }
};

/* ── PUT /task-meta/category/:id ────────────────────────── */
exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: "Name is required" });

    const trimmed = name.trim();
    const existing = await TaskMeta.findById(id);
    if (!existing) return res.status(404).json({ message: "Category not found" });

    const oldName = existing.category;
    existing.category = trimmed;
    await existing.save();

    // Cascade update to Task, DailyWorkUpdate, StandaloneWorkUpdate
    await Promise.all([
      Task.updateMany({ category: oldName }, { $set: { category: trimmed } }).catch(() => {}),
      DailyWorkUpdate.updateMany({ category: oldName }, { $set: { category: trimmed } }).catch(() => {}),
      StandaloneWorkUpdate.updateMany({ category: oldName }, { $set: { category: trimmed } }).catch(() => {})
    ]);

    res.json({ success: true, message: "Category updated", data: existing });
  } catch (err) {
    res.status(500).json({ message: "Update failed", error: err.message });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    let deleted = null;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      deleted = await TaskMeta.findByIdAndDelete(id);
    }
    if (!deleted) {
      deleted = await TaskMeta.findOneAndDelete({ category: id });
    }
    if (!deleted) return res.status(404).json({ message: "Category not found" });

    const catName = deleted.category;
    // Clean up category references in Task, DailyWorkUpdate, StandaloneWorkUpdate
    await Promise.all([
      Task.updateMany({ category: catName }, { $set: { category: "" } }).catch(() => {}),
      DailyWorkUpdate.updateMany({ category: catName }, { $set: { category: "" } }).catch(() => {}),
      StandaloneWorkUpdate.updateMany({ category: catName }, { $set: { category: "" } }).catch(() => {})
    ]);

    res.json({ success: true, message: "Category deleted" });
  } catch (err) {
    res.status(500).json({ message: "Deletion failed", error: err.message });
  }
};

/* ── DELETE /task-meta/project ──────────────────────────── */
exports.deleteProject = async (req, res) => {
  try {
    const { categoryId, projectName } = req.body;
    if (!categoryId || !projectName) return res.status(400).json({ message: "Missing params" });

    const mapping = await TaskMeta.findById(categoryId);
    if (!mapping) return res.status(404).json({ message: "Category not found" });

    mapping.projects = mapping.projects.filter(p => p !== projectName);
    await mapping.save();

    res.json({ success: true, message: "Project deleted" });
  } catch (err) {
    res.status(500).json({ message: "Deletion failed", error: err.message });
  }
};

/* ── PUT /task-meta/project ─────────────────────────────── */
exports.updateProject = async (req, res) => {
  try {
    const { categoryId, oldProjectName, newProjectName } = req.body;
    if (!categoryId || !oldProjectName || !newProjectName?.trim()) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const trimmedNew = newProjectName.trim();
    const mapping = await TaskMeta.findById(categoryId);
    if (!mapping) return res.status(404).json({ message: "Category not found" });

    // Check if new name already exists in this category
    if (mapping.projects.some(p => p.toLowerCase() === trimmedNew.toLowerCase())) {
      return res.status(409).json({ message: "A project with this name already exists in this category" });
    }

    // Replace the name in the array
    mapping.projects = mapping.projects.map(p => p === oldProjectName ? trimmedNew : p);
    await mapping.save();

    res.json({ success: true, message: "Project renamed successfully", data: mapping });
  } catch (err) {
    res.status(500).json({ message: "Update failed", error: err.message });
  }
};

/* ── POST /task-meta/page ────────────────────────────────── */
exports.addPage = async (req, res) => {
  try {
    const { category, project, name } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: "Page name is required" });
    if (!project?.trim()) return res.status(400).json({ success: false, message: "Project is required" });
    if (!category?.trim()) return res.status(400).json({ success: false, message: "Category is required" });

    const trimmedPage = name.trim();
    const trimmedCat = category.trim();
    const trimmedProj = project.trim();

    const mapping = await TaskMeta.findOne({ category: { $regex: new RegExp(`^${trimmedCat}$`, "i") } });
    if (!mapping) return res.status(404).json({ success: false, message: "Category not found" });

    if (!mapping.projectPages) mapping.projectPages = [];
    let projPageEntry = mapping.projectPages.find(pp => pp.project && pp.project.toLowerCase() === trimmedProj.toLowerCase());
    if (!projPageEntry) {
      mapping.projectPages.push({ project: trimmedProj, pages: [trimmedPage] });
      projPageEntry = mapping.projectPages[mapping.projectPages.length - 1];
    } else {
      if (!projPageEntry.pages) projPageEntry.pages = [];
      const alreadyExists = projPageEntry.pages.some(p => p && p.toLowerCase() === trimmedPage.toLowerCase());
      if (alreadyExists) {
        return res.status(409).json({ success: false, message: "Page already exists for this project" });
      }
      projPageEntry.pages.push(trimmedPage);
    }

    mapping.markModified("projectPages");
    await mapping.save();

    res.status(201).json({
      success: true,
      message: `Page "${trimmedPage}" added to "${trimmedProj}"`,
      data: {
        category: mapping.category,
        project: trimmedProj,
        page: trimmedPage,
        pages: projPageEntry.pages
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ── DELETE /task-meta/page ──────────────────────────────── */
exports.deletePage = async (req, res) => {
  try {
    const category = req.body?.category || req.query?.category;
    const project = req.body?.project || req.query?.project;
    const page = req.body?.page || req.query?.page || req.body?.name || req.query?.name;
    if (!page?.trim() || !project?.trim() || !category?.trim()) {
      return res.status(400).json({ success: false, message: "Category, project, and page are required" });
    }

    const mapping = await TaskMeta.findOne({ category: { $regex: new RegExp(`^${category.trim()}$`, "i") } });
    if (!mapping || !mapping.projectPages) {
      return res.status(404).json({ success: false, message: "Category or pages not found" });
    }

    const projPageEntry = mapping.projectPages.find(pp => pp.project && pp.project.toLowerCase() === project.trim().toLowerCase());
    if (!projPageEntry) {
      return res.status(404).json({ success: false, message: "Project not found in pages" });
    }

    projPageEntry.pages = (projPageEntry.pages || []).filter(p => p && p.toLowerCase() !== page.trim().toLowerCase());
    mapping.markModified("projectPages");
    await mapping.save();

    res.json({
      success: true,
      message: `Page "${page}" removed from "${project}"`,
      data: { pages: projPageEntry.pages }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
