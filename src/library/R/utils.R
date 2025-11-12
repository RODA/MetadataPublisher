keep_attributes <- function(x) {
    # if it's a list or atomic with attributes
    attrs <- attributes(x)
    if (!is.null(attrs)) {
        # remove names that cause circularity
        attrs <- attrs[setdiff(names(attrs), c("names", "class"))]
    }

    if (is.list(x)) {
        # recurse into list children
        x <- lapply(x, keep_attributes)
        nms <- names(x)
        names(x)[nms == ""] <- "value"
        if (length(attrs)) x$.attributes <- attrs
        # Drop empty value nodes (attributes-only)
        if (length(x) == 0) return(list(.attributes = attrs))
        return(x)
    }

    # atomic value
    if (length(attrs)) {
        return(list(value = x, .attributes = attrs))
    }

    return(x)
}

# Normalize a codebook-like nested list into an explicit children-array shape
# Output node shape:
#   list(
#     name = <element name>,
#     attributes = list(...)?,
#     value = <string>? ,
#     children = list(childNode, ...)?
#   )

normalize_element <- function(name, x) {
    # Extract and drop meta
    attrs <- NULL
    if (is.list(x)) {
        if (!is.null(x$.attributes)) {
            attrs <- x$.attributes;
            x$.attributes <- NULL
        }

        if (!is.null(x$.extra)) {
            x$.extra <- NULL
        }
    }

    node <- list(name = name)
    if (!is.null(attrs)) node$attributes <- attrs

    # Leaf if x is a list with only `value` (after meta removed)
    if (is.list(x)) {
        nn <- names(x)
        non_meta <- setdiff(nn, c("value"))
        if (length(non_meta) == 0 && "value" %in% nn) {
            node$value <- x$value
            return(node)
        }

        # Otherwise, treat remaining entries as children
        node$children <- normalize_children(x)
        return(node)
    }

    # Fallback: atomic
    node$value <- x
    node
}

normalize_children <- function(x) {
    if (!is.list(x)) return(list())
    keys <- names(x)
    # Remove meta keys
    keys <- keys[!(keys %in% c(".attributes", ".extra"))]
    out <- list()
    used <- rep(FALSE, length(keys))

    # Helper to escape regex
    esc <- function(s) gsub("([.^$|()*+?{}\\[\\]\\\\])", "\\\\\\1", s, perl = TRUE)

    for (i in seq_along(keys)) {
        if (used[i]) next
        k <- keys[i]
        base <- sub("\\.\\d+$", "", k, perl = TRUE)
        # all keys with same base or base.N
        rx <- paste0("^", esc(base), "(\\\\.\\\\d+)?$")
        idx <- which(grepl(rx, keys, perl = TRUE))
        used[idx] <- TRUE
        for (j in idx) {
            child_name <- base
            child_val <- x[[ j ]]
            out[[length(out) + 1]] <- normalize_element(child_name, child_val)
        }
    }
    out
}

normalize_codebook <- function(cb) {
    # cb is expected from keep_attributes(codeBook)
    cb <- keep_attributes(cb)
    attrs <- NULL
    if (is.list(cb) && !is.null(cb$.attributes)) { attrs <- cb$.attributes; cb$.attributes <- NULL }
    node <- list(name = "codeBook")
    if (!is.null(attrs)) node$attributes <- attrs
    node$children <- normalize_children(cb)
    node
}
