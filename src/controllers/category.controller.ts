import { Request, Response } from 'express'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { slugify } from '../utils/helpers.js'
import Category from '../models/category.model.js'
import Event from '../models/event.model.js'

// Public listing needs an eventCount per category (used by the "Browse by
// vibe" cards on the home page, the Explore sidebar, and anywhere else that
// wants to show how active a category is) — only counts events a visitor
// could actually see. That means matching listPublicEvents' own visibility
// rule exactly: status approved/postponed AND still upcoming. Without the
// startDate check, a category whose only approved event has already passed
// would still show a nonzero count here while the actual Explore/home
// listing (which excludes past events) correctly shows none — the count
// and the results disagreeing is the bug this guards against.
export const listPublicCategories = tryCatchWrapper(async (req: Request, res: Response) => {
  const [categories, counts] = await Promise.all([
    Category.find({ isActive: true }).sort({ name: 1 }).lean(),
    Event.aggregate([
      { $match: { status: { $in: ['approved', 'postponed'] }, startDate: { $gte: new Date() } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ])

  const countByCategoryId = new Map(counts.map(c => [String(c._id), c.count]))

  const body = categories.map(category => ({
    ...category,
    eventCount: countByCategoryId.get(String(category._id)) ?? 0,
  }))

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Categories fetched',
    body,
  })
})

export const listAllCategories = tryCatchWrapper(async (req: Request, res: Response) => {
  const categories = await Category.find().sort({ name: 1 }).lean()
  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Categories fetched',
    body: categories,
  })
})

export const createCategory = tryCatchWrapper(async (req: Request, res: Response) => {
  const { name } = req.body

  const slug = slugify(name)
  const existing = await Category.findOne({ $or: [{ name }, { slug }] }).lean()
  if (existing) {
    return sendTsRestError(res, 409, 'A category with this name already exists')
  }

  const category = await Category.create({ name, slug })

  return sendTsRestSuccess(res, 201, {
    success: true,
    message: 'Category created',
    body: category.toObject(),
  })
})

export const updateCategory = tryCatchWrapper(async (req: Request, res: Response) => {
  const { id } = req.params
  const { name, isActive } = req.body

  const category = await Category.findById(id)
  if (!category) {
    return sendTsRestError(res, 404, 'Category not found')
  }

  if (name) {
    category.name = name
    category.slug = slugify(name)
  }
  if (typeof isActive === 'boolean') {
    category.isActive = isActive
  }

  await category.save()

  return sendTsRestSuccess(res, 200, {
    success: true,
    message: 'Category updated',
    body: category.toObject(),
  })
})
