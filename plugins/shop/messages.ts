import type { FieldLabels } from "tansy/plugin";

/** The shop's dashboard words, read as `t("ext.shop.<key>")`, and its collections' names. */
export const messages = {
  en: {
    section: "Shop",
    pages: { "shop/overview": "Overview" },
    collections: { "shop-store": "Shop page", "shop-cart": "Cart page", "shop-account": "Orders page" },
    widgets: { "shop-to-ship": "Shop" },
    actions: { "shop-ship": "Mark shipped", "shop-deliver": "Mark delivered" },
    settings: {
      notifyCustomers: { label: "Email customers", description: "When their order is paid, and when it ships." },
      notifyStaff: { label: "Email new orders to", description: "An address that hears about every paid order. Empty for none." },
      restockOnRefund: { label: "Restock refunded orders", description: "Put the stock of a fully refunded order back." },
      cancelUnpaidAfterDays: { label: "Cancel unpaid orders after (days)", description: "Orders nobody paid for are cancelled after this long. A payment that arrives later still counts." },
    },
    overview: {
      title: "Shop",
      description: "Orders waiting to ship, problems to look at, and what's running low. Ship an order from its actions in the Orders list.",
      cantReadOrders: "You can't read Orders. Ask an administrator for the Shop manager role.",
      totals: "{orders, plural, one {# order} other {# orders}} and {revenue} in the last 30 days · {toShip} to ship · {pending} awaiting payment",
      stats: { orders: "Orders, 30 days", revenue: "Revenue, 30 days", toShip: "To ship", pending: "Awaiting payment" },
      toShip: "To ship",
      nothingToShip: "Nothing to ship.",
      needsLook: "Needs a look",
      lowStock: "Low stock",
      cantReadProducts: "You can't read Products.",
      nothingLow: "Nothing is running low.",
      soldOut: "Sold out",
      product: "Product {id}",
    },
    columns: { order: "Order", items: "Items", customer: "Customer", country: "Country", paid: "Paid", total: "Total", state: "State", problem: "Problem", product: "Product", left: "Left", item: "Item", sku: "SKU", price: "Price", qty: "Qty", subtotal: "Subtotal", option: "Option", stock: "Stock" },
    widget: {
      cantRead: "You can't read Orders.",
      toShip: "{count, plural, one {# order to ship} other {# orders to ship}}",
      pending: "{count} awaiting payment",
      needsLook: "Some orders need a look: see the Shop overview",
    },
    order: {
      title: "Order",
      sums: "Items {items} · Shipping {shipping} · Total {total}",
      notChanged: "The order wasn't changed.",
      onlyPaid: "Only a paid order can be shipped.",
      tracking: "Tracking link, if the carrier gave one (https://…). Leave empty for none:",
      onlyPaidOrShipped: "Only a paid or shipped order can be delivered.",
    },
    variants: {
      title: "Variants",
      none: "None. Sold as one product, at its own price and stock.",
      draft: " (draft)",
      productsPrice: "Product's",
      notCounted: "Not counted",
      add: "Add a variant",
      addAfter: ", and choose this product on it.",
    },
  },
  ar: {
    section: "المتجر",
    pages: { "shop/overview": "نظرة عامة" },
    collections: { "shop-store": "صفحة المتجر", "shop-cart": "صفحة السلة", "shop-account": "صفحة الطلبات" },
    widgets: { "shop-to-ship": "المتجر" },
    actions: { "shop-ship": "وسم كمشحون", "shop-deliver": "وسم كمُسلَّم" },
    settings: {
      notifyCustomers: { label: "راسل العملاء بالبريد", description: "حين يُدفع طلبهم، وحين يُشحن." },
      notifyStaff: { label: "أرسل الطلبات الجديدة بالبريد إلى", description: "عنوان يُبلَّغ بكل طلب مدفوع. اتركه فارغًا لعدم الإرسال." },
      restockOnRefund: { label: "أعد المخزون للطلبات المستردة", description: "أعد مخزون الطلب المسترد بالكامل." },
      cancelUnpaidAfterDays: { label: "ألغِ الطلبات غير المدفوعة بعد (أيام)", description: "تُلغى الطلبات التي لم يدفعها أحد بعد هذه المدة. الدفعة التي تصل لاحقًا تُحسب مع ذلك." },
    },
    overview: {
      title: "المتجر",
      description: "طلبات تنتظر الشحن، ومشكلات تحتاج النظر، وما يوشك على النفاد. اشحن طلبًا من إجراءاته في قائمة الطلبات.",
      cantReadOrders: "لا يمكنك قراءة الطلبات. اطلب من المسؤول دور مدير المتجر.",
      totals: "{orders, plural, zero {لا طلبات} one {طلب واحد} two {طلبان} few {# طلبات} many {# طلبًا} other {# طلب}} و{revenue} في آخر 30 يومًا · {toShip} للشحن · {pending} بانتظار الدفع",
      stats: { orders: "الطلبات، 30 يومًا", revenue: "الإيرادات، 30 يومًا", toShip: "للشحن", pending: "بانتظار الدفع" },
      toShip: "للشحن",
      nothingToShip: "لا شيء للشحن.",
      needsLook: "تحتاج إلى نظر",
      lowStock: "مخزون منخفض",
      cantReadProducts: "لا يمكنك قراءة المنتجات.",
      nothingLow: "لا شيء يوشك على النفاد.",
      soldOut: "نفد",
      product: "المنتج {id}",
    },
    columns: { order: "الطلب", items: "العناصر", customer: "العميل", country: "البلد", paid: "الدفع", total: "الإجمالي", state: "الحالة", problem: "المشكلة", product: "المنتج", left: "المتبقي", item: "العنصر", sku: "رمز المنتج", price: "السعر", qty: "الكمية", subtotal: "المجموع الفرعي", option: "الخيار", stock: "المخزون" },
    widget: {
      cantRead: "لا يمكنك قراءة الطلبات.",
      toShip: "{count, plural, zero {لا طلبات للشحن} one {طلب واحد للشحن} two {طلبان للشحن} few {# طلبات للشحن} many {# طلبًا للشحن} other {# طلب للشحن}}",
      pending: "{count} بانتظار الدفع",
      needsLook: "بعض الطلبات تحتاج إلى نظر: انظر نظرة المتجر العامة",
    },
    order: {
      title: "الطلب",
      sums: "العناصر {items} · الشحن {shipping} · الإجمالي {total}",
      notChanged: "لم يتغير الطلب.",
      onlyPaid: "لا يُشحن إلا طلب مدفوع.",
      tracking: "رابط التتبع إن أعطاك الناقل واحدًا (https://…). اتركه فارغًا إن لم يكن:",
      onlyPaidOrShipped: "لا يُسلَّم إلا طلب مدفوع أو مشحون.",
    },
    variants: {
      title: "الأنواع",
      none: "لا شيء. يُباع منتجًا واحدًا بسعره ومخزونه.",
      draft: " (مسودة)",
      productsPrice: "سعر المنتج",
      notCounted: "غير محسوب",
      add: "أضف نوعًا",
      addAfter: "، واختر هذا المنتج فيه.",
    },
  },
};

/** The collections' names in other interface languages. Added by a migration, so names an owner set stay. */
export const COLLECTION_LABELS: Record<string, Record<string, string>> = {
  "shop-products": { ar: "المنتجات" },
  "shop-variants": { ar: "أنواع المنتجات" },
  "shop-categories": { ar: "فئات المتجر" },
  "shop-shipping-zones": { ar: "مناطق الشحن" },
  "shop-orders": { ar: "الطلبات" },
  "shop-store": { ar: "المتجر" },
  "shop-cart": { ar: "السلة" },
  "shop-account": { ar: "طلباتي" },
};

/** Fields' words in other interface languages, by collection. Added by a migration, so words an owner set stay. */
export const FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  "shop-products": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    slug: {
      labels: {
        ar: "الاسم اللطيف"
      },
      descriptions: {
        ar: "يظهر في العنوان. أحرف لاتينية صغيرة وأرقام وشرطات. يُملأ من العنوان إن تُرك فارغًا."
      }
    },
    summary: {
      labels: {
        ar: "الملخص"
      }
    },
    images: {
      labels: {
        ar: "الصور"
      },
      descriptions: {
        ar: "الأولى هي صورة المنتج في القوائم."
      }
    },
    price: {
      labels: {
        ar: "السعر"
      },
      descriptions: {
        ar: "بعملة المتجر، كما يدفعه الناس، مثل 19.99."
      }
    },
    compareAtPrice: {
      labels: {
        ar: "السعر قبل الخصم"
      },
      descriptions: {
        ar: "سعر سابق أعلى، يظهر مشطوبًا."
      }
    },
    sku: {
      labels: {
        ar: "رمز المنتج (SKU)"
      }
    },
    stock: {
      labels: {
        ar: "المخزون"
      },
      descriptions: {
        ar: "كم بقي. الفارغ يعني أنه لا يُعدّ ولا ينفد أبدًا."
      }
    },
    categories: {
      labels: {
        ar: "التصنيفات"
      }
    },
    shipping: {
      labels: {
        ar: "يُشحن"
      },
      descriptions: {
        ar: "يُرسل بالبريد. اتركه مطفأً للتنزيلات والخدمات."
      }
    },
    weightGrams: {
      labels: {
        ar: "الوزن (غرام)"
      }
    },
    download: {
      labels: {
        ar: "ملف التنزيل"
      },
      descriptions: {
        ar: "يُعطى للمشترين بعد الدفع. مخفي عن غيرهم."
      }
    },
    description: {
      labels: {
        ar: "الوصف"
      }
    }
  },
  "shop-variants": {
    product: {
      labels: {
        ar: "المنتج"
      }
    },
    title: {
      labels: {
        ar: "العنوان"
      },
      descriptions: {
        ar: "ما يختاره المشترون، مثل متوسط / أزرق."
      }
    },
    sku: {
      labels: {
        ar: "رمز المنتج (SKU)"
      }
    },
    price: {
      labels: {
        ar: "السعر"
      },
      descriptions: {
        ar: "فارغ لسعر المنتج."
      }
    },
    stock: {
      labels: {
        ar: "المخزون"
      },
      descriptions: {
        ar: "كم بقي. الفارغ يعني أنه لا يُعدّ ولا ينفد أبدًا."
      }
    },
    image: {
      labels: {
        ar: "الصورة"
      }
    },
    position: {
      labels: {
        ar: "الترتيب"
      },
      descriptions: {
        ar: "الأصغر أولًا."
      }
    }
  },
  "shop-categories": {
    name: {
      labels: {
        ar: "الاسم"
      }
    },
    slug: {
      labels: {
        ar: "الاسم اللطيف"
      },
      descriptions: {
        ar: "يظهر في العنوان. أحرف لاتينية صغيرة وأرقام وشرطات. يُملأ من العنوان إن تُرك فارغًا."
      }
    },
    description: {
      labels: {
        ar: "الوصف"
      }
    },
    image: {
      labels: {
        ar: "الصورة"
      }
    }
  },
  "shop-shipping-zones": {
    name: {
      labels: {
        ar: "الاسم"
      }
    },
    countries: {
      labels: {
        ar: "الدول"
      },
      descriptions: {
        ar: "رموز الدول من حرفين، مثل [\"US\", \"CA\"]. و[\"*\"] تعني كل مكان لا تغطيه منطقة أخرى."
      }
    },
    rate: {
      labels: {
        ar: "سعر الشحن"
      },
      descriptions: {
        ar: "تكلفة شحن الطلب."
      }
    },
    freeOver: {
      labels: {
        ar: "شحن مجاني ابتداءً من"
      },
      descriptions: {
        ar: "الشحن مجاني حين تبلغ قيمة المنتجات هذا المبلغ على الأقل. الفارغ يعني أبدًا."
      }
    }
  },
  "shop-orders": {
    title: {
      labels: {
        ar: "العنوان"
      },
      descriptions: {
        ar: "ما تسميه صفحة الدفع."
      }
    },
    customer: {
      labels: {
        ar: "العميل (معرّف المستخدم)"
      }
    },
    language: {
      labels: {
        ar: "اللغة"
      },
      descriptions: {
        ar: "اللغة التي تسوّق بها العميل. تصله رسائل الطلب بها."
      }
    },
    email: {
      labels: {
        ar: "البريد الإلكتروني"
      }
    },
    state: {
      labels: {
        ar: "الحالة"
      },
      options: {
        pending: {
          ar: "بانتظار الدفع"
        },
        paid: {
          ar: "مدفوع"
        },
        shipped: {
          ar: "مشحون"
        },
        delivered: {
          ar: "مُسلَّم"
        },
        cancelled: {
          ar: "ملغى"
        },
        refunded: {
          ar: "مُسترد"
        }
      }
    },
    lines: {
      labels: {
        ar: "البنود"
      },
      descriptions: {
        ar: "ما طُلب، بأسعاره وقت الطلب."
      }
    },
    subtotal: {
      labels: {
        ar: "المجموع الفرعي"
      },
      descriptions: {
        ar: "المنتجات."
      }
    },
    shippingCost: {
      labels: {
        ar: "تكلفة الشحن"
      },
      descriptions: {
        ar: "الشحن."
      }
    },
    total: {
      labels: {
        ar: "الإجمالي"
      },
      descriptions: {
        ar: "ما يدفعه العميل. تحصّله إضافة المدفوعات."
      }
    },
    currency: {
      labels: {
        ar: "العملة"
      }
    },
    needsShipping: {
      labels: {
        ar: "يحتاج شحنًا"
      }
    },
    country: {
      labels: {
        ar: "الدولة"
      }
    },
    address: {
      labels: {
        ar: "العنوان البريدي"
      }
    },
    trackingUrl: {
      labels: {
        ar: "رابط التتبع"
      }
    },
    downloads: {
      labels: {
        ar: "التنزيلات"
      },
      descriptions: {
        ar: "ملفات يحصل عليها العميل من تنزيلات المنتجات بعد الدفع."
      }
    },
    paidAt: {
      labels: {
        ar: "تاريخ الدفع"
      }
    },
    shippedAt: {
      labels: {
        ar: "تاريخ الشحن"
      }
    },
    deliveredAt: {
      labels: {
        ar: "تاريخ التسليم"
      }
    },
    flag: {
      labels: {
        ar: "تنبيه"
      },
      descriptions: {
        ar: "أمر يجب أن ينظر فيه الطاقم، مثل نفاد المخزون بعد الدفع."
      }
    },
    staffNotes: {
      labels: {
        ar: "ملاحظات الطاقم"
      }
    }
  },
  "shop-store": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    intro: {
      labels: {
        ar: "المقدمة"
      }
    },
    currency: {
      labels: {
        ar: "العملة"
      },
      descriptions: {
        ar: "عملة الأسعار. يجب أن يستخدم حقل الإجمالي في الطلبات العملة نفسها."
      }
    }
  },
  "shop-cart": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    intro: {
      labels: {
        ar: "المقدمة"
      }
    }
  },
  "shop-account": {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    intro: {
      labels: {
        ar: "المقدمة"
      }
    }
  }
};

/** The same for the blocks the plugin's schema makes, by block. */
export const BLOCK_FIELD_LABELS: Record<string, Record<string, FieldLabels>> = {
  shop_products: {
    title: {
      labels: {
        ar: "العنوان"
      }
    },
    category: {
      labels: {
        ar: "التصنيف"
      },
      descriptions: {
        ar: "فارغ لأحدث المنتجات."
      }
    },
    limit: {
      labels: {
        ar: "العدد"
      }
    }
  },
  shop_add_to_cart: {
    product: {
      labels: {
        ar: "المنتج"
      }
    }
  }
};
