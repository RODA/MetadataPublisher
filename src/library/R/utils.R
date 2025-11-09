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
        if (length(attrs)) x$.attributes <- attrs
        return(x)
    }

    # atomic value
    if (length(attrs)) {
        return(list(value = x, .attributes = attrs))
    }

    x
}
